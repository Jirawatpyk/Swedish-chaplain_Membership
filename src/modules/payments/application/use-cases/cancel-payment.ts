/**
 * T059 — cancelPayment use-case (F5 / payments-api.md § 2).
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
import type { PaymentId } from '../../domain/payment';
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

  return await deps.paymentsRepo.withTx(async (tx) => {
    const payment = await deps.paymentsRepo.lockForUpdate(
      tx,
      input.paymentId,
      input.tenantId,
    );
    if (!payment) {
      // Cross-tenant probe audit (best-effort outside tx — the row is
      // invisible under RLS so we cannot distinguish "row never existed"
      // from "row exists in a different tenant the actor cannot see").
      // `acting_tenant_id` = the tenant under whose RLS context the
      // probe ran (NOT the unknown subject's tenant — naming clarified
      // audit 2026-04-25 finding #12).
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

    // Ownership check — payment must belong to actor's member record.
    // RLS already filters cross-tenant rows out, so reaching this branch
    // means SAME tenant + DIFFERENT member (e.g., member A trying to
    // cancel member B's payment within the same chamber). Distinct from
    // the `!payment` cross-tenant case above (audit 2026-04-25 finding
    // #11).
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

    const cancelResult = await deps.processorGateway.cancelPaymentIntent(
      payment.processorPaymentIntentId,
      settings.processorAccountId,
    );
    if (!cancelResult.ok) {
      // H-2 (review 2026-04-27): forensic audit on Stripe-side
      // cancel failure. Without this, an admin reviewing the audit
      // log after a member-reported failed-cancel sees no trace.
      // Best-effort emit on `null` tx since we are about to roll the
      // outer tx back via the err() return — using the held tx would
      // discard the audit row on rollback.
      // R2 HIGH (2026-04-27 reliability-guardian): the Stripe SDK call
      // still runs INSIDE `withTx` so the row's FOR UPDATE lock blocks
      // concurrent webhook arrivals for up to 10s under tail latency.
      // Two-phase split (lock+validate → unlock → Stripe →
      // relock+commit-audit) tracked as post-ship cleanup — mirrors
      // issueRefund's pattern but needs careful state-machine
      // handling (the cancel can race against an in-flight
      // payment_intent.succeeded webhook). A follow-up event type
      // `payment_cancel_attempt_failed` (separate from `payment_canceled`)
      // is also tracked for the failure path so audit-log queries can
      // distinguish "cancel succeeded" from "cancel attempt failed at
      // Stripe" — requires a new enum + migration.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_canceled',
        actorUserId: input.actorUserId,
        summary: `Payment ${payment.id} cancel attempt failed at Stripe (${cancelResult.error.kind})`,
        payload: {
          payment_id: payment.id,
          invoice_id: payment.invoiceId,
          actor_type: 'member',
          outcome: 'stripe_error',
          processor_error_kind: cancelResult.error.kind,
        },
        retentionYears: retentionFor('payment_canceled'),
      });
      // Stripe gateway error.kind has 3 values (retryable |
      // permanent | idempotency_conflict). Map to the cancel
      // route's binary kind: retryable stays retryable, both
      // permanent + idempotency_conflict surface as 'permanent'
      // (no Retry-After header).
      const kind: 'retryable' | 'permanent' =
        cancelResult.error.kind === 'retryable' ? 'retryable' : 'permanent';
      return err<CancelPaymentError>({
        code: 'processor_unavailable',
        kind,
        reason: cancelResult.error.kind,
      });
    }

    const completedAt = new Date(deps.clock.nowMs());
    await deps.paymentsRepo.updateStatus(tx, {
      paymentId: payment.id,
      tenantId: input.tenantId,
      nextStatus: 'canceled',
      completedAt,
    });

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_canceled',
      actorUserId: input.actorUserId,
      summary: `Payment ${payment.id} canceled by member`,
      payload: {
        payment_id: payment.id,
        invoice_id: payment.invoiceId,
        actor_type: 'member',
      },
      retentionYears: retentionFor('payment_canceled'),
    });

    return ok<CancelPaymentSuccess>({
      paymentId: payment.id,
      status: 'canceled',
      completedAt: completedAt.toISOString(),
    });
  });
}
