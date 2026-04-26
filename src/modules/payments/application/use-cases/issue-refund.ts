/**
 * T108 — issueRefund use-case (F5 / Phase 6 / FR-011b + US4).
 *
 * Admin-initiated refund against a succeeded Payment. Per spec
 * § "Side effects (success path)" in `contracts/payments-api.md` § 3:
 *
 *   1. Lock payment row FOR UPDATE
 *   2. Reject if status ∉ { succeeded, partially_refunded }
 *   3. Reject if a concurrent in-flight refund holds a pending row
 *   4. Pre-flight refund-not-exceeding-remainder (FR-011b)
 *   5. Allocate refund-sequence + idempotency key `rfnd-{paymentId}-{seq}`
 *   6. Insert pending refund row + audit `refund_initiated` (atomic)
 *   7. Stripe `refunds.create` (outside tx — non-rollbackable external call)
 *   8. On Stripe success → F4 `issueCreditNoteFromRefund` bridge
 *   9. Finalise: update refund + payment status + audit `refund_succeeded`
 *  10. On Stripe / F4 failure → flip refund row to `failed` + audit `refund_failed`
 *
 * Two-transaction design:
 *   - Phase A (prepareRefund tx)  — lock, validate, insert pending, audit init
 *   - External                   — Stripe createRefund + F4 issueCN
 *   - Phase B (finaliseRefund tx) — update refund/payment status + final audit
 *
 * Why two tx (instead of confirm-payment's single-tx pattern):
 *   - F4's `issueCreditNoteFromRefund` is a complete sub-transaction
 *     (PDF render + Blob upload + sequence allocation + outbox enqueue
 *      + audit). It does NOT accept a caller tx today. Wrapping the
 *     whole flow in one F5 tx would force F4 to either join (large
 *     refactor) or break our atomicity. The two-tx model accepts the
 *     well-known "Stripe succeeded but F4 commit not yet visible"
 *     reconciliation window covered by the `out_of_band_refund_detected`
 *     runbook (`docs/runbooks/out-of-band-refund.md`).
 *   - Concurrency is still safe: Phase A commits the pending refund
 *     row AND inserts before Stripe is called, so a second concurrent
 *     `issueRefund` sees the pending row in its own Phase-A lock and
 *     rejects with `refund_in_progress`.
 *
 * Coverage policy: Principle II — 100% branch coverage required.
 *
 * Pure Application — no framework / ORM imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  InvoicingBridgePort,
  PaymentsRepo,
  ProcessorGatewayPort,
  RefundsRepo,
  TenantPaymentSettingsRepo,
} from '../ports';
import { checkRefundNotExceedingRemainder } from '../../domain/invariants/refund-not-exceeding-remainder';
import {
  asPaymentId,
  parsePaymentId,
  type Payment,
  type PaymentId,
} from '../../domain/payment';
import { retentionFor } from '../ports/audit-port';

// ---------------------------------------------------------------------------
// Public input / output / error shapes
// ---------------------------------------------------------------------------

export interface IssueRefundInput {
  readonly tenantId: string;
  readonly paymentId: string;       // route-side raw — parsed inside
  readonly amountSatang: bigint;    // > 0
  readonly reason: string;          // 1..500 chars; single-line (no CR/LF)
  readonly actorUserId: string;     // admin UUID from session
  readonly correlationId: string;
  readonly requestId: string | null;
}

export interface IssueRefundSuccess {
  readonly refund: {
    readonly id: string;
    readonly paymentId: string;
    readonly invoiceId: string;
    readonly amountSatang: bigint;
    readonly reason: string;
    readonly status: 'succeeded';
    readonly processorRefundId: string;
    readonly creditNoteId: string;
    readonly creditNoteNumber: string;
    readonly completedAt: string;
  };
  readonly payment: {
    readonly id: string;
    readonly status: 'partially_refunded' | 'refunded';
    readonly refundedAmountSatang: bigint;
    readonly remainingRefundableSatang: bigint;
  };
  readonly invoice: {
    readonly id: string;
    readonly status: 'partially_credited' | 'credited';
  };
}

export type IssueRefundError =
  | { readonly code: 'invalid_payment_id'; readonly raw: string }
  | { readonly code: 'payment_not_found' }
  | {
      readonly code: 'payment_not_refundable';
      readonly currentStatus: Payment['status'];
    }
  | {
      readonly code: 'refund_exceeds_remaining';
      readonly requestedSatang: bigint;
      readonly remainingSatang: bigint;
    }
  | { readonly code: 'refund_in_progress' }
  | {
      readonly code: 'processor_unavailable';
      readonly kind: 'retryable' | 'idempotency_conflict' | 'permanent';
      readonly reason: string;
    }
  | { readonly code: 'f4_bridge_error'; readonly detail: string }
  | { readonly code: 'tenant_settings_missing' };

/**
 * Stripe Refund.reason enum literal. Exported as a const so an SDK
 * version drift (or a future code-path that wants `'duplicate'` /
 * `'fraudulent'`) surfaces at compile time instead of being a free-
 * form string.
 */
const STRIPE_REFUND_REASON_REQUESTED_BY_CUSTOMER = 'requested_by_customer' as const;

/**
 * Phase-B failure helper — flips the pending refund row to `failed`
 * + emits a `refund_failed` audit row in a single tx. Used by both
 * the Stripe-failure branch and the F4-bridge-failure branch
 * (Q2: previously copy-pasted with subtly
 * different payloads — drift risk).
 *
 * Caller supplies the discriminating fields (`failureReasonCode`,
 * `summary`, optional `extraPayload`) — the helper owns the shared
 * scaffolding (tx open, updateStatus call, audit shape, retention
 * lookup).
 */
async function finaliseFailedRefund(
  deps: IssueRefundDeps,
  input: {
    readonly refundId: string;
    readonly paymentId: string;
    readonly invoiceId: string;
    readonly tenantId: string;
    readonly requestId: string | null;
    readonly actorUserId: string;
    readonly failureReasonCode: string;
    readonly summary: string;
    readonly extraPayload?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const failedAt = new Date(deps.clock.nowMs());
  await deps.paymentsRepo.withTx(async (tx) => {
    await deps.refundsRepo.updateStatus(tx, {
      refundId: input.refundId,
      tenantId: input.tenantId,
      nextStatus: 'failed',
      failureReasonCode: input.failureReasonCode,
      completedAt: failedAt,
    });
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'refund_failed',
      actorUserId: input.actorUserId,
      summary: input.summary,
      payload: {
        refund_id: input.refundId,
        payment_id: input.paymentId,
        invoice_id: input.invoiceId,
        failure_reason_code: input.failureReasonCode,
        ...(input.extraPayload ?? {}),
      },
      retentionYears: retentionFor('refund_failed'),
    });
  });
}

export interface IssueRefundDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly refundsRepo: RefundsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly invoicingBridge: InvoicingBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly generateRefundId: () => string;
  /** Idempotency-key wrapper (mirrors initiate-payment pattern). */
  readonly idempotencyKeyFactory: (baseKey: string) => string;
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function issueRefund(
  deps: IssueRefundDeps,
  input: IssueRefundInput,
): Promise<Result<IssueRefundSuccess, IssueRefundError>> {
  // -------------------------------------------------------------------------
  // Step 0 — parse + tenant settings
  // -------------------------------------------------------------------------
  const paymentIdParse = parsePaymentId(input.paymentId);
  if (!paymentIdParse.ok) {
    return err({ code: 'invalid_payment_id', raw: input.paymentId });
  }
  const paymentId: PaymentId = paymentIdParse.value;

  const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
  if (!settings) {
    return err({ code: 'tenant_settings_missing' });
  }

  // -------------------------------------------------------------------------
  // Phase A — prepareRefund tx: lock, validate, insert pending, audit init
  // -------------------------------------------------------------------------
  type PreparedRefund =
    | { readonly kind: 'prepared'; readonly refundId: string; readonly idempotencyKey: string; readonly payment: Payment; readonly succeededSumBefore: bigint }
    | { readonly kind: 'rejected'; readonly error: IssueRefundError };

  const prepared: PreparedRefund = await deps.paymentsRepo.withTx(async (tx) => {
    const payment = await deps.paymentsRepo.lockForUpdate(tx, paymentId, input.tenantId);
    if (!payment) {
      return { kind: 'rejected', error: { code: 'payment_not_found' } } as const;
    }

    if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
      return {
        kind: 'rejected',
        error: { code: 'payment_not_refundable', currentStatus: payment.status },
      } as const;
    }

    // E3: one combined SELECT instead of 3
    // separate roundtrips inside the FOR UPDATE lock window.
    const ctx = await deps.refundsRepo.getRefundContextForUpdate(
      tx,
      input.tenantId,
      paymentId,
    );
    if (ctx.pendingCount > 0) {
      return { kind: 'rejected', error: { code: 'refund_in_progress' } } as const;
    }

    const invariant = checkRefundNotExceedingRemainder({
      paymentAmountSatang: payment.amountSatang,
      succeededSumSatang: ctx.succeededSumSatang,
      newRefundSatang: input.amountSatang,
    });
    if (!invariant.ok) {
      return {
        kind: 'rejected',
        error: {
          code: 'refund_exceeds_remaining',
          requestedSatang: invariant.error.requestedSatang,
          remainingSatang: invariant.error.remainingSatang,
        },
      } as const;
    }

    const idempotencyKey = deps.idempotencyKeyFactory(`rfnd-${paymentId}-${ctx.nextSeq}`);
    const refundId = deps.generateRefundId();
    const initiatedAt = new Date(deps.clock.nowMs());

    await deps.refundsRepo.insert(tx, {
      id: refundId,
      tenantId: input.tenantId,
      paymentId: asPaymentId(paymentId),
      invoiceId: payment.invoiceId,
      amountSatang: input.amountSatang,
      reason: input.reason,
      status: 'pending',
      processorRefundId: null,
      initiatorUserId: input.actorUserId,
      correlationId: input.correlationId,
      initiatedAt,
    });

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'refund_initiated',
      actorUserId: input.actorUserId,
      summary: `Refund initiated by admin: ${input.amountSatang.toString()} satang on payment ${paymentId}`,
      payload: {
        refund_id: refundId,
        payment_id: paymentId,
        invoice_id: payment.invoiceId,
        amount_satang: input.amountSatang.toString(),
        reason: input.reason,
        idempotency_key: idempotencyKey,
      },
      retentionYears: retentionFor('refund_initiated'),
    });

    return {
      kind: 'prepared',
      refundId,
      idempotencyKey,
      payment,
      succeededSumBefore: ctx.succeededSumSatang,
    } as const;
  });

  if (prepared.kind === 'rejected') {
    return err(prepared.error);
  }

  // -------------------------------------------------------------------------
  // External Step — Stripe createRefund (outside any DB tx)
  // -------------------------------------------------------------------------
  const stripeRefund = await deps.processorGateway.createRefund({
    paymentIntentId: prepared.payment.processorPaymentIntentId,
    amountSatang: input.amountSatang,
    reason: STRIPE_REFUND_REASON_REQUESTED_BY_CUSTOMER,
    metadata: {
      refundId: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      tenantId: input.tenantId,
      reason: input.reason,
    },
    idempotencyKey: prepared.idempotencyKey,
    stripeAccount: settings.processorAccountId,
  });

  if (!stripeRefund.ok) {
    await finaliseFailedRefund(deps, {
      refundId: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      tenantId: input.tenantId,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      failureReasonCode: stripeRefund.error.kind,
      summary: `Stripe refund failed (${stripeRefund.error.kind}) for refund ${prepared.refundId}`,
    });
    // Q1 fix: preserve all 3 gateway kinds —
    // previously `idempotency_conflict` silently collapsed to
    // `permanent`. Also propagate the gateway's `reason` string
    // verbatim instead of overwriting with the discriminator.
    return err({
      code: 'processor_unavailable',
      kind: stripeRefund.error.kind,
      reason: stripeRefund.error.reason,
    });
  }

  // -------------------------------------------------------------------------
  // External Step — F4 bridge issueCreditNoteFromRefund
  // -------------------------------------------------------------------------
  const cnResult = await deps.invoicingBridge.issueCreditNoteFromRefund({
    tenantId: input.tenantId,
    invoiceId: prepared.payment.invoiceId,
    refundId: prepared.refundId,
    amountSatang: input.amountSatang,
    reason: input.reason,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
  });

  if (!cnResult.ok) {
    // Stripe refund already succeeded — Stripe-refund-without-CN
    // reconciliation is owned by the `out_of_band_refund_detected`
    // runbook (`docs/runbooks/out-of-band-refund.md`).
    await finaliseFailedRefund(deps, {
      refundId: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      tenantId: input.tenantId,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      failureReasonCode: `f4_bridge_${cnResult.error.code}`,
      summary: `F4 credit-note issuance failed for refund ${prepared.refundId} (Stripe refund ${stripeRefund.value.id} succeeded — ops follow up via out-of-band-refund runbook)`,
      extraPayload: {
        processor_refund_id: stripeRefund.value.id,
        f4_detail: cnResult.error.detail,
      },
    });
    return err({ code: 'f4_bridge_error', detail: cnResult.error.detail });
  }

  // -------------------------------------------------------------------------
  // Phase B (success) — finalise refund + payment status + audit succeeded
  // -------------------------------------------------------------------------
  const completedAt = new Date(deps.clock.nowMs());
  const newSucceededSum = prepared.succeededSumBefore + input.amountSatang;
  const isFullyRefunded = newSucceededSum >= prepared.payment.amountSatang;
  const nextPaymentStatus = isFullyRefunded ? 'refunded' : 'partially_refunded';

  // C2: wrap Phase B in try/catch so a DB outage
  // post-Stripe + post-F4 success does not leave the refund row
  // permanently `pending` (which would block all future refunds on
  // this payment via the `refund_in_progress` guard). On Phase B
  // throw, flip the row to `failed` via `finaliseFailedRefund`
  // (separate tx — the outer one already rolled back), audit
  // `refund_failed` with `f4_bridge_phase_b_db_error`, and surface
  // the failure to the caller as `f4_bridge_error`. Stripe + F4 CN
  // already succeeded so the out-of-band-refund runbook is the
  // recovery path for ops.
  try {
    await deps.paymentsRepo.withTx(async (tx) => {
      await deps.refundsRepo.updateStatus(tx, {
        refundId: prepared.refundId,
        tenantId: input.tenantId,
        nextStatus: 'succeeded',
        processorRefundId: stripeRefund.value.id,
        creditNoteId: cnResult.value.creditNoteId,
        completedAt,
      });

      await deps.paymentsRepo.updateStatus(tx, {
        paymentId,
        tenantId: input.tenantId,
        nextStatus: nextPaymentStatus,
        completedAt,
      });

      // Invoice status derived arithmetically: F5 invariant is "one
      // PaymentIntent per invoice covers the whole invoice" so
      // `payment.amountSatang === invoice.totalSatang`. When the
      // cumulative refund equals the payment amount, the invoice is
      // fully credited; otherwise partially credited. Avoids a second
      // DB roundtrip to F4.
      const nextInvoiceStatus: 'credited' | 'partially_credited' = isFullyRefunded
        ? 'credited'
        : 'partially_credited';

      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'refund_succeeded',
        actorUserId: input.actorUserId,
        summary: `Refund ${prepared.refundId} succeeded — credit note ${cnResult.value.creditNoteNumber} issued for ${input.amountSatang.toString()} satang`,
        payload: {
          refund_id: prepared.refundId,
          payment_id: paymentId,
          invoice_id: prepared.payment.invoiceId,
          processor_refund_id: stripeRefund.value.id,
          credit_note_id: cnResult.value.creditNoteId,
          credit_note_number: cnResult.value.creditNoteNumber,
          amount_satang: input.amountSatang.toString(),
          payment_next_status: nextPaymentStatus,
          invoice_next_status: nextInvoiceStatus,
        },
        retentionYears: retentionFor('refund_succeeded'),
      });
    });
  } catch (phaseBError) {
    const detail =
      phaseBError instanceof Error ? phaseBError.message : String(phaseBError);
    await finaliseFailedRefund(deps, {
      refundId: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      tenantId: input.tenantId,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      failureReasonCode: 'f4_bridge_phase_b_db_error',
      summary: `Phase B finalisation failed for refund ${prepared.refundId} (Stripe refund ${stripeRefund.value.id} + F4 CN ${cnResult.value.creditNoteId} both succeeded — ops follow up via out-of-band-refund runbook)`,
      extraPayload: {
        processor_refund_id: stripeRefund.value.id,
        credit_note_id: cnResult.value.creditNoteId,
        credit_note_number: cnResult.value.creditNoteNumber,
        phase_b_detail: detail.slice(0, 200),
      },
    }).catch(() => {
      // If even the failure-finalise tx throws, the pending row
      // stays — the T130a stale-pending-refund sweep cron is the
      // last-resort recovery (Phase 9 polish).
    });
    return err({ code: 'f4_bridge_error', detail });
  }

  return ok({
    refund: {
      id: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      amountSatang: input.amountSatang,
      reason: input.reason,
      status: 'succeeded',
      processorRefundId: stripeRefund.value.id,
      creditNoteId: cnResult.value.creditNoteId,
      creditNoteNumber: cnResult.value.creditNoteNumber,
      completedAt: completedAt.toISOString(),
    },
    payment: {
      id: paymentId,
      status: nextPaymentStatus,
      refundedAmountSatang: newSucceededSum,
      remainingRefundableSatang: isFullyRefunded
        ? 0n
        : prepared.payment.amountSatang - newSucceededSum,
    },
    invoice: {
      id: prepared.payment.invoiceId,
      status: isFullyRefunded ? 'credited' : 'partially_credited',
    },
  });
}
