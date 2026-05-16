/**
 * cancelPayment use-case (F5 / payments-api.md § 2).
 *
 * Member-initiated cancel of own pending payment.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  PaymentsRepo,
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '../ports';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { isAllowed, type F5Role } from '../../domain/rbac-policy';
import type { Payment, PaymentId } from '../../domain/payment';
import { retentionFor } from '../ports/audit-port';

export interface CancelPaymentInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorRole: F5Role;
  readonly actorMemberId: string;
  readonly paymentId: PaymentId;
  readonly requestId: string | null;
}

export interface CancelPaymentSuccess {
  readonly paymentId: PaymentId;
  readonly status: 'canceled';
  readonly completedAt: string; // ISO
}

export type CancelPaymentError =
  | { readonly code: 'forbidden_role' }
  | { readonly code: 'payment_not_found' }
  | { readonly code: 'forbidden_payment' }
  | { readonly code: 'payment_not_cancelable'; readonly currentStatus: string }
  | {
      readonly code: 'processor_unavailable';
      // C3: explicit `kind` distinguishes
      // retryable (Stripe transient) from permanent (tenant
      // settings missing, etc.) so the route's Retry-After header
      // can fire only on the retryable variant. Without `kind`,
      // `buildUseCaseErrorTelemetry` defaults to 30s on every
      // cancel `processor_unavailable` — wrong for permanent
      // failures.
      readonly kind: 'retryable' | 'permanent';
      readonly reason: string;
    };

export interface CancelPaymentDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export async function cancelPayment(
  deps: CancelPaymentDeps,
  input: CancelPaymentInput,
): Promise<Result<CancelPaymentSuccess, CancelPaymentError>> {
  if (!isAllowed(input.actorRole, 'payments', 'cancel-own')) {
    return err({ code: 'forbidden_role' });
  }

  // Settings load runs OUTSIDE withTx because `getByTenantId` does not
  // accept a `tx` parameter (its Drizzle adapter wraps an `unstable_cache`
  // fetcher on its own connection). Pulling it into withTx would NOT
  // share the row-lock's snapshot. The stale-settings window is bounded
  // by the cache lifetime (1h) and admin processor-account rotation is
  // rare — accept it. R2-C1 revert.
  const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
  if (!settings) {
    // Permanent: tenant settings missing means a configuration gap;
    // retrying does not heal it.
    return err({ code: 'processor_unavailable', kind: 'permanent', reason: 'tenant_settings_missing' });
  }

  // F5R1-IMP1 — two-phase split. The previous single-withTx version
  // held the payment-row FOR UPDATE lock across the Stripe SDK call
  // (≤10s timeout), so a concurrent payment_intent.succeeded webhook
  // for the same payment row blocked waiting up to 10s under tail
  // latency. With Vercel's ~30s function timeout, back-to-back
  // contention could stack two function slots per payment row.
  //
  // Pattern:
  //   Phase A — withTx: lock + validate + cross-tenant audit on miss,
  //     release tx. The FOR UPDATE lock auto-releases at tx commit;
  //     audit emits on `null` tx for the miss path so the forensic
  //     trail survives the err() return.
  //   Stripe call OUTSIDE tx — gateway timeout is now bounded by
  //     Stripe SDK alone (10s), not by tx lifetime.
  //   Phase B — withTx: re-acquire FOR UPDATE lock, re-check state
  //     (a webhook may have flipped it between phases — that is the
  //     whole point of relocking), updateStatus + audit emit atomically.
  //     If a webhook beat us and the row is already `canceled`, return
  //     ok idempotently (member sees the same success the webhook
  //     would have rendered).
  //
  // Mirrors the H-3 pattern from confirmPayment + issueRefund.

  // ---------------- Phase A: lock + validate + release ----------------
  type PhaseAOk = { readonly payment: Payment };
  const phaseA = await deps.paymentsRepo.withTx<
    Result<PhaseAOk, CancelPaymentError>
  >(async (tx) => {
    const payment = await deps.paymentsRepo.lockForUpdate(
      tx,
      input.paymentId,
      input.tenantId,
    );
    if (!payment) {
      // Cross-tenant probe audit (best-effort on `null` tx — row is
      // invisible under RLS so we cannot distinguish "row never
      // existed" from "row exists in a different tenant the actor
      // cannot see"). `acting_tenant_id` = the tenant under whose
      // RLS context the probe ran.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Probe on payment ${input.paymentId} (not found / not owned)`,
        payload: {
          acting_tenant_id: input.tenantId,
          probing_actor_id: input.actorUserId,
          target_entity: 'payment',
          target_id: input.paymentId,
        },
        retentionYears: retentionFor('payment_cross_tenant_probe'),
      });
      return err<CancelPaymentError>({ code: 'payment_not_found' });
    }

    // Ownership check — RLS filters cross-tenant rows; this branch
    // means SAME tenant + DIFFERENT member (e.g., member A cancelling
    // member B's payment within the same chamber).
    if (payment.memberId !== input.actorMemberId) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Ownership mismatch probe on payment ${input.paymentId} (same-tenant cross-member)`,
        payload: {
          acting_tenant_id: input.tenantId,
          probing_actor_id: input.actorUserId,
          target_entity: 'payment',
          target_id: input.paymentId,
          target_owner_member_id: payment.memberId,
        },
        retentionYears: retentionFor('payment_cross_tenant_probe'),
      });
      return err<CancelPaymentError>({ code: 'forbidden_payment' });
    }

    const transition = canTransition(payment.status, 'canceled');
    if (!transition.ok) {
      return err<CancelPaymentError>({
        code: 'payment_not_cancelable',
        currentStatus: payment.status,
      });
    }
    return ok({ payment });
  });
  if (!phaseA.ok) return phaseA;
  const { payment } = phaseA.value;

  // ---------------- Stripe call OUTSIDE tx ----------------
  const cancelResult = await deps.processorGateway.cancelPaymentIntent(
    payment.processorPaymentIntentId,
    settings.processorAccountId,
  );
  if (!cancelResult.ok) {
    // Forensic audit on Stripe-side cancel failure. `null` tx so the
    // audit row survives the err() return below.
    //
    // F5R1-E4 closure — dedicated `payment_cancel_attempt_failed`
    // event type (migration 0148 + audit-port union). Audit-log
    // dashboards filtering `event_type='payment_canceled'` now see
    // only successes; cancel-attempt-failed is a sibling row.
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_cancel_attempt_failed',
      actorUserId: input.actorUserId,
      summary: `Payment ${payment.id} cancel attempt failed at Stripe (${cancelResult.error.kind})`,
      payload: {
        payment_id: payment.id,
        invoice_id: payment.invoiceId,
        actor_type: 'member',
        processor_error_kind: cancelResult.error.kind,
      },
      retentionYears: retentionFor('payment_cancel_attempt_failed'),
    });
    const kind: 'retryable' | 'permanent' =
      cancelResult.error.kind === 'retryable' ? 'retryable' : 'permanent';
    return err<CancelPaymentError>({
      code: 'processor_unavailable',
      kind,
      reason: cancelResult.error.kind,
    });
  }

  // ---------------- Phase B: re-lock + commit + audit ----------------
  return await deps.paymentsRepo.withTx(async (tx) => {
    // Re-acquire FOR UPDATE. Possible states observed under contention:
    //   1. status='canceled' — webhook beat us; idempotent ack.
    //   2. status='succeeded' — concurrent payment_intent.succeeded
    //      webhook landed first (PromptPay & out-of-order card
    //      deliveries). Stripe's cancel call may still have returned
    //      ok if the PI was non-terminal at the SDK boundary. Falling
    //      through to updateStatus would silently overwrite the
    //      succeeded row → SC-013 break. Re-check canTransition; on
    //      illegal transition emit forensic audit + err.
    //   3. status='pending' — happy path, proceed with update.
    const fresh = await deps.paymentsRepo.lockForUpdate(
      tx,
      input.paymentId,
      input.tenantId,
    );
    if (!fresh) {
      // F5R2-H1: Phase A saw the row, RLS context unchanged — the
      // most plausible cause of a Phase B miss is a manual DB
      // intervention or a future SaaS migration touching the row.
      // Stripe has already canceled the PI by this point; the local
      // row's absence is the only forensic signal ops will have. Emit
      // a probe audit on `null` tx so the row survives the err return.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Phase B unexpected lockForUpdate miss after Phase A success on payment ${input.paymentId} — Stripe cancel may have already settled`,
        payload: {
          acting_tenant_id: input.tenantId,
          probing_actor_id: input.actorUserId,
          target_entity: 'payment',
          target_id: input.paymentId,
        },
        retentionYears: retentionFor('payment_cross_tenant_probe'),
      });
      return err<CancelPaymentError>({ code: 'payment_not_found' });
    }

    if (fresh.status === 'canceled') {
      // Webhook beat us. Idempotent return — the original
      // `payment_canceled` audit row was already emitted by the
      // webhook path. completedAt comes from the fresh read.
      //
      // F5R2-M2 — also emit a `payment_cross_tenant_probe` audit on
      // `null` tx (best-effort) so ops dashboards can distinguish
      // "member cancelled successfully" from "webhook beat us to
      // it". The probe shape is reused (forensic class fits — the
      // probe schema covers same-tenant ownership-mismatch +
      // sibling forensic classes). Pre-fix this branch returned
      // ok silently, so the "webhook-beat" volume was invisible
      // — sustained high rate would indicate Stripe clock drift /
      // out-of-order delivery that operators should know about.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Phase B webhook-beat: payment ${fresh.id} already canceled when member's cancel request arrived (idempotent ack)`,
        payload: {
          acting_tenant_id: input.tenantId,
          probing_actor_id: input.actorUserId,
          target_entity: 'payment',
          target_id: fresh.id,
        },
        retentionYears: retentionFor('payment_cross_tenant_probe'),
      });
      return ok<CancelPaymentSuccess>({
        paymentId: fresh.id,
        status: 'canceled',
        completedAt:
          fresh.completedAt?.toISOString() ??
          new Date(deps.clock.nowMs()).toISOString(),
      });
    }

    // F5R2-CRIT-1 — defence-in-depth re-check. Phase A already
    // verified canTransition under its own lock; here we re-check
    // because the world may have changed during the Stripe call.
    // Most likely culprit: a payment_intent.succeeded webhook flipped
    // the row to 'succeeded' between Phase A release and Phase B
    // re-lock. canTransition('succeeded', 'canceled') is err
    // (succeeded is post-terminal-fund-movement; cannot return funds
    // by transitioning to canceled — that requires a refund). Emit
    // forensic audit + return payment_not_cancelable so the route
    // surfaces a 409 to the member.
    const transition = canTransition(fresh.status, 'canceled');
    if (!transition.ok) {
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cancel_attempt_failed',
        actorUserId: input.actorUserId,
        summary: `Phase B race: payment ${fresh.id} status=${fresh.status} after Stripe cancel call returned ok — Stripe Dashboard reconciliation may be needed`,
        payload: {
          payment_id: fresh.id,
          invoice_id: fresh.invoiceId,
          actor_type: 'member',
          processor_error_kind: 'permanent',
        },
        retentionYears: retentionFor('payment_cancel_attempt_failed'),
      });
      return err<CancelPaymentError>({
        code: 'payment_not_cancelable',
        currentStatus: fresh.status,
      });
    }

    const completedAt = new Date(deps.clock.nowMs());
    // F5R2-CRIT-1 — pass `expectedCurrentStatus` so the repo's WHERE
    // clause includes `status = fresh.status`. If a webhook lands
    // between this canTransition check and the UPDATE statement (a
    // narrow but possible window), the repo returns null instead of
    // silently overwriting. We treat null as the same race class as
    // the canTransition failure above.
    const updated = await deps.paymentsRepo.updateStatus(tx, {
      paymentId: fresh.id,
      tenantId: input.tenantId,
      nextStatus: 'canceled',
      expectedCurrentStatus: fresh.status,
      completedAt,
    });
    if (updated === null) {
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cancel_attempt_failed',
        actorUserId: input.actorUserId,
        summary: `Phase B narrow race: updateStatus zero-match for payment ${fresh.id} (status changed mid-Phase-B)`,
        payload: {
          payment_id: fresh.id,
          invoice_id: fresh.invoiceId,
          actor_type: 'member',
          processor_error_kind: 'permanent',
        },
        retentionYears: retentionFor('payment_cancel_attempt_failed'),
      });
      return err<CancelPaymentError>({
        code: 'payment_not_cancelable',
        currentStatus: fresh.status,
      });
    }

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_canceled',
      actorUserId: input.actorUserId,
      summary: `Payment ${fresh.id} canceled by member`,
      payload: {
        payment_id: fresh.id,
        invoice_id: fresh.invoiceId,
        actor_type: 'member',
      },
      retentionYears: retentionFor('payment_canceled'),
    });

    return ok<CancelPaymentSuccess>({
      paymentId: fresh.id,
      status: 'canceled',
      completedAt: completedAt.toISOString(),
    });
  });
}
