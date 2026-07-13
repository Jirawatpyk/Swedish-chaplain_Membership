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
import { addSatang, asSatang, satangToProcessorAmount, subSatang, type Satang } from '@/lib/money';
import type {
  AuditPort,
  ClockPort,
  InvoicingBridgePort,
  LoggerPort,
  PaymentsRepo,
  ProcessorGatewayPort,
  RefundsRepo,
  TenantPaymentSettingsRepo,
} from '../ports';
import { checkRefundNotExceedingRemainder } from '../../domain/invariants/refund-not-exceeding-remainder';
import { finalizeSucceededRefund } from './_finalize-succeeded-refund';
import {
  asPaymentId,
  parsePaymentId,
  type Payment,
  type PaymentId,
} from '../../domain/payment';
import { retentionFor } from '../ports/audit-port';
import { paymentsMetrics } from '@/lib/metrics';
import { paymentsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Public input / output / error shapes
// ---------------------------------------------------------------------------

export interface IssueRefundInput {
  readonly tenantId: string;
  readonly paymentId: string;       // route-side raw — parsed inside
  // F5R3 H-5 (2026-05-16) — branded Satang prevents unit confusion.
  readonly amountSatang: Satang;    // > 0
  readonly reason: string;          // 1..500 chars; single-line (no CR/LF)
  readonly actorUserId: string;     // admin UUID from session
  readonly correlationId: string;
  readonly requestId: string | null;
}

/**
 * #1 (2026-07-11) — `issueRefund` now discriminates on the Stripe refund
 * status. A synchronous `succeeded` books the credit note immediately
 * (`kind: 'succeeded'`, existing envelope). An async `pending` /
 * `requires_action` refund is NOT booked — the row stays `pending` with
 * its `processor_refund_id` attached, and the eventual
 * `charge.refund.updated` webhook (A.11) finalises it (`kind: 'pending'`).
 */
export type IssueRefundSuccess =
  | {
      readonly kind: 'succeeded';
      readonly refund: {
        readonly id: string;
        readonly paymentId: string;
        readonly invoiceId: string;
        readonly amountSatang: Satang;
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
        readonly refundedAmountSatang: Satang;
        readonly remainingRefundableSatang: Satang;
      };
      readonly invoice: {
        readonly id: string;
        readonly status: 'partially_credited' | 'credited';
      };
    }
  | {
      readonly kind: 'pending';
      readonly refund: {
        readonly id: string;
        readonly status: 'pending';
        readonly processorRefundId: string;
      };
    };

export type IssueRefundError =
  | { readonly code: 'invalid_payment_id'; readonly raw: string }
  | { readonly code: 'payment_not_found' }
  | {
      readonly code: 'payment_not_refundable';
      readonly currentStatus: Payment['status'];
    }
  | {
      readonly code: 'refund_exceeds_remaining';
      readonly requestedSatang: Satang;
      readonly remainingSatang: Satang;
    }
  | { readonly code: 'refund_in_progress' }
  | {
      readonly code: 'processor_unavailable';
      readonly kind: 'retryable' | 'idempotency_conflict' | 'permanent';
      readonly reason: string;
    }
  /**
   * B.1 review Fix#1 (2026-07-12) — the PRE-FLIGHT F4 credited-total read
   * failed (`getInvoiceCreditedTotal` errored). Money did NOT move — the
   * refund is rejected BEFORE any Stripe `createRefund` call, so it is safe to
   * retry and NO orphaned Stripe refund exists. DISTINCT from
   * `f4_bridge_error` (which means Stripe DID succeed but the POST-Stripe F4
   * credit-note bridge failed → the out-of-band-refund runbook). Keeping the
   * two apart stops an on-call from hunting a non-existent orphaned refund.
   */
  | { readonly code: 'f4_preflight_read_error'; readonly detail: string }
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
    /**
     * #1 (2026-07-11) — when Stripe DID create the refund but it later
     * settled `failed`/`canceled`, persist the `re_…` id on the failed
     * row (forensic completeness + webhook-matchable). Omitted when the
     * `createRefund` call itself failed (no processor id exists).
     * CHECK-safe: `refunds_succeeded_iff_complete` holds because the
     * `failed` status keeps `credit_note_id` NULL (biconditional
     * `false = false`).
     */
    readonly processorRefundId?: string;
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
      ...(input.processorRefundId !== undefined
        ? { processorRefundId: input.processorRefundId }
        : {}),
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
  // T141 metric: refund failure forensics by reason_code (OUTSIDE tx
  // — the helper completed its own write tx; emit only after commit
  // attempt to align with the audit row's existence).
  paymentsMetrics.refundFailedCount(input.tenantId, input.failureReasonCode);
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
  /**
   * R2 reliability finding (2026-04-27): optional logger so the
   * outer `.catch(() => …)` at the failure-finalise tail can record a
   * structured warn before the stale-pending-refund sweep picks it up.
   */
  readonly logger?: LoggerPort;
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function issueRefund(
  deps: IssueRefundDeps,
  input: IssueRefundInput,
): Promise<Result<IssueRefundSuccess, IssueRefundError>> {
  // T140 OTel span — admin-initiated refund lifecycle (Phase A → Stripe
  // → F4 CN bridge → Phase B). Children: Drizzle tx + Stripe SDK auto-
  // instrumented spans.
  return await paymentsTracer().startActiveSpan(
    'payments.refund',
    {
      attributes: {
        'payments.payment_id': input.paymentId,
        'payments.tenant_id': input.tenantId,
        'payments.amount_satang': satangToProcessorAmount(input.amountSatang),
      },
    },
    async (span) => {
      try {
        const result = await issueRefundBody(deps, input);
        span.setAttribute(
          'payments.outcome',
          result.ok ? 'ok' : `err:${result.error.code}`,
        );
        return result;
      } catch (e) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          // F5R3 LOW (2026-05-16) — H-4 hygiene; see confirm-payment.ts.
          message: e instanceof Error ? e.constructor.name : 'refund_threw',
        });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

async function issueRefundBody(
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
    | { readonly kind: 'prepared'; readonly refundId: string; readonly idempotencyKey: string; readonly payment: Payment; readonly succeededSumBefore: Satang }
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

    // B.1 (#4) — fetch the invoice's F4-authoritative credited + total so the
    // pre-flight caps the refundable at the invoice's un-credited headroom
    // (`total − credited`) IN ADDITION to the payment-based cap. A refund that
    // passes the payment cap but exceeds this headroom (e.g. a manual F4 credit
    // note already reduced it) would move money at Stripe that F4 then refuses
    // as an over-credit CN → an orphaned Stripe refund. The invoiceId comes
    // from the locked payment row. On a read failure we REFUSE the refund
    // (never proceed blind to Stripe). This runs INSIDE the FOR UPDATE window,
    // BEFORE the pending-row insert, so a rejected refund writes no row and no
    // `refund_initiated` audit (AS6).
    //
    // B.1 review Fix#2 — thread THIS Phase A tx into the F4 read (externalTx)
    // so the credited-total read runs on the SAME pooled connection that holds
    // the payment `FOR UPDATE` lock, instead of `makeGetInvoiceDeps` opening a
    // 2nd `runInTenant` (a second pooled connection acquired while connection
    // #1 is still held → self-deadlock risk on pool acquisition under
    // concurrent refunds). Mirrors the mutation bridge `markPaidFromProcessor`
    // (which already threads its caller tx to avoid the nested connection).
    // The tenant context (`SET LOCAL app.current_tenant`) is already set on
    // this connection by `paymentsRepo.withTx` (= `runInTenant`), so the F4
    // read stays correctly tenant-scoped on it.
    const invoiceCredited = await deps.invoicingBridge.getInvoiceCreditedTotal({
      tenantId: input.tenantId,
      invoiceId: payment.invoiceId,
      externalTx: tx,
    });
    if (!invoiceCredited.ok) {
      // Fix#1 — DISTINCT pre-flight code (money did NOT move; safe to retry;
      // no out-of-band refund exists), NOT the post-Stripe `f4_bridge_error`.
      return {
        kind: 'rejected',
        error: {
          code: 'f4_preflight_read_error',
          detail: `invoice_credited_total_read_failed:${invoiceCredited.error.code}`,
        },
      } as const;
    }

    const invariant = checkRefundNotExceedingRemainder({
      paymentAmountSatang: payment.amountSatang,
      succeededSumSatang: ctx.succeededSumSatang,
      newRefundSatang: input.amountSatang,
      invoiceCreditedTotalSatang: invoiceCredited.value.creditedTotalSatang,
      invoiceTotalSatang: invoiceCredited.value.totalSatang,
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

  // T141 metric: count admin-initiated refunds by method + partial flag.
  // Phase-A committed (pending row + audit), so this counter aligns
  // with the `refund_initiated` audit existence — even if Stripe later
  // declines, the attempt is recorded.
  paymentsMetrics.refundInitiateCount(
    input.tenantId,
    prepared.payment.method,
    input.amountSatang < prepared.payment.amountSatang,
  );

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
  // A.6 / #2 — attach the Stripe refund id onto the still-`pending` row
  // (short tx) so it is webhook-matchable BEFORE we branch on status. A
  // `charge.refund.updated` for this refund then resolves to the app row
  // instead of the out-of-band path. GUARD: run ONLY here — the row was
  // just inserted `pending` and no flip has happened, so this never
  // touches a possibly-terminal row (`attachProcessorRefundId` has no
  // pending precondition).
  // -------------------------------------------------------------------------
  await deps.paymentsRepo.withTx(async (tx) => {
    await deps.refundsRepo.attachProcessorRefundId(tx, {
      refundId: prepared.refundId,
      tenantId: input.tenantId,
      processorRefundId: stripeRefund.value.id,
    });
  });

  // Phase A snapshot arithmetic (unchanged) — drives the payment-status
  // flip + the success envelope's refunded/remaining amounts. F5R3 H-5:
  // branded helpers preserve the `Satang` brand. A.11 moves the
  // equivalent read INTO `finalizeSucceededRefund` for the webhook
  // consumer; the admin path keeps the Phase A snapshot here.
  const newSucceededSum = addSatang(
    prepared.succeededSumBefore,
    input.amountSatang,
  );
  const isFullyRefunded = newSucceededSum >= prepared.payment.amountSatang;
  const nextPaymentStatus: 'partially_refunded' | 'refunded' = isFullyRefunded
    ? 'refunded'
    : 'partially_refunded';

  // -------------------------------------------------------------------------
  // #1 — branch on the Stripe refund status. ONLY `succeeded` books the
  // F4 credit note + flips payment. `pending`/`requires_action` await the
  // `charge.refund.updated` webhook (A.11); `failed`/`canceled` mark the
  // refund failed. This is the fix for bug #1 (previously EVERY Stripe
  // response was treated as success at creation time).
  // -------------------------------------------------------------------------
  const refundStatus = stripeRefund.value.status;

  if (refundStatus === 'failed' || refundStatus === 'canceled') {
    // Stripe created the refund but it settled failed/canceled. Mark the
    // row failed (no CN) + persist the `re_…` id (forensic + matchable).
    await finaliseFailedRefund(deps, {
      refundId: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      tenantId: input.tenantId,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      processorRefundId: stripeRefund.value.id,
      failureReasonCode: `stripe_refund_${refundStatus}`,
      summary: `Stripe refund settled ${refundStatus} for refund ${prepared.refundId} (${stripeRefund.value.id})`,
    });
    return err({
      code: 'processor_unavailable',
      kind: 'permanent',
      reason: refundStatus,
    });
  }

  if (refundStatus !== 'succeeded') {
    // `pending` | `requires_action` | any unexpected status → the refund
    // is in flight. Leave the row `pending` (with `processor_refund_id`
    // attached); the `charge.refund.updated` webhook (A.11) or the
    // Stripe-aware sweep (A.14) finalises it by real status. NEVER book
    // success or a CN here. An unexpected status is treated the same
    // (safest: never books success) + logged for drift detection.
    if (refundStatus !== 'pending' && refundStatus !== 'requires_action') {
      deps.logger?.warn('issue_refund.unexpected_stripe_refund_status', {
        tenantId: input.tenantId,
        refundId: prepared.refundId,
        paymentId,
        // Bounded status string only — never card/raw-event data (SAQ-A).
        stripeRefundStatus: refundStatus,
      });
    }
    // A.16 (H-e) — the refund is now awaiting Stripe's async
    // `charge.refund.updated` webhook; emit the monitoring signal so a disabled
    // subscription (async refunds hang forever) is alertable.
    paymentsMetrics.refundPendingAwaitingProcessor(input.tenantId);
    return ok({
      kind: 'pending',
      refund: {
        id: prepared.refundId,
        status: 'pending',
        processorRefundId: stripeRefund.value.id,
      },
    });
  }

  // -------------------------------------------------------------------------
  // `succeeded` — finalise via the shared `finalizeSucceededRefund` helper
  // inside a Phase B tx. C2 (unchanged intent): wrap in try/catch so a DB
  // outage AFTER Stripe + F4 CN success flips the row to `failed` (+
  // double-fault handling) rather than leaving it stuck `pending` (which
  // would block all future refunds via the `refund_in_progress` guard).
  // The `expectedCurrentStatus='pending'` guard inside the helper closes
  // bug #1's double-book window (fixes the old `:474` missing guard); a
  // `null` return there is a benign sibling-won no-op (helper returns ok).
  // -------------------------------------------------------------------------
  let finalizeResult: Awaited<ReturnType<typeof finalizeSucceededRefund>>;
  try {
    finalizeResult = await deps.paymentsRepo.withTx((tx) =>
      finalizeSucceededRefund(deps, tx, {
        refundId: prepared.refundId,
        tenantId: input.tenantId,
        paymentId,
        invoiceId: prepared.payment.invoiceId,
        amountSatang: input.amountSatang,
        reason: input.reason,
        processorRefundId: stripeRefund.value.id,
        paymentNextStatus: nextPaymentStatus,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        path: 'admin_initiated',
      }),
    );
  } catch (phaseBError) {
    // H-5 (review 2026-04-27): constructor name only — raw Postgres
    // error.message can carry SQL fragments / row data into the audit.
    // NOTE: the F4 CN was issued INSIDE the helper (F4's own tx, already
    // committed) but its id is unavailable here (the helper threw before
    // returning it) — the out-of-band-refund runbook resolves the CN via
    // `credit_notes.source_refund_id`, and F4 emits its own CN-issued
    // audit, so the id is still traceable.
    const detailKind =
      phaseBError instanceof Error ? phaseBError.constructor.name : 'unknown';
    await finaliseFailedRefund(deps, {
      refundId: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      tenantId: input.tenantId,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      processorRefundId: stripeRefund.value.id,
      failureReasonCode: 'f4_bridge_phase_b_db_error',
      summary: `Phase B finalisation failed for refund ${prepared.refundId} (Stripe refund ${stripeRefund.value.id} succeeded — ops follow up via out-of-band-refund runbook)`,
      extraPayload: {
        processor_refund_id: stripeRefund.value.id,
        phase_b_error_kind: detailKind,
      },
    }).catch(async (finaliseError) => {
      // Double-fault: even the failure-finalise tx threw → the row stays
      // pending; the T130a stale-pending-refund sweep cron is the
      // last-resort recovery. F5R3 CR-7: bump a counter + emit the
      // `stale_pending_refund_detected` audit SYNCHRONOUSLY (10y forensic
      // trail immediately, not up to 12h later) + a structured warn.
      const finaliseErrKind =
        finaliseError instanceof Error
          ? finaliseError.constructor.name
          : 'unknown';
      paymentsMetrics.refundFinaliseDoubleFault(input.tenantId);
      deps.logger?.warn('issue_refund.finalise_failed_double_fault', {
        tenantId: input.tenantId,
        refundId: prepared.refundId,
        paymentId,
        invoiceId: prepared.payment.invoiceId,
        processorRefundId: stripeRefund.value.id,
        finaliseErrKind,
        recovery: 'awaiting_stale_pending_refund_sweep',
      });
      await deps.audit
        .emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          eventType: 'stale_pending_refund_detected',
          actorUserId: input.actorUserId,
          summary: `Double-fault: issueRefund Phase B + finaliseFailedRefund both threw — refund ${prepared.refundId} stuck pending; Stripe ${stripeRefund.value.id} succeeded; ops follow up via runbook`,
          payload: {
            refund_id: prepared.refundId,
            payment_id: paymentId,
            invoice_id: prepared.payment.invoiceId,
            amount_satang: input.amountSatang.toString(),
            age_minutes: 0,
            original_initiator_user_id: input.actorUserId,
            original_correlation_id: input.requestId ?? 'no-request-id',
            runbook_url: 'docs/runbooks/stale-pending-refund-sweep.md',
          },
          retentionYears: retentionFor('stale_pending_refund_detected'),
        })
        .catch(() => {
          // Triple-fault swallow — the audit adapter already log-and-
          // swallows + bumps useCaseAuditEmitFailed.
        });
    });
    return err({ code: 'f4_bridge_error', detail: detailKind });
  }

  if (!finalizeResult.ok) {
    // F4 credit-note bridge declined. Stripe refund already succeeded →
    // Stripe-refund-without-CN reconciliation is owned by the
    // `out_of_band_refund_detected` runbook. Mark the refund failed.
    await finaliseFailedRefund(deps, {
      refundId: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      tenantId: input.tenantId,
      requestId: input.requestId,
      actorUserId: input.actorUserId,
      processorRefundId: stripeRefund.value.id,
      failureReasonCode: `f4_bridge_${finalizeResult.error.code}`,
      summary: `F4 credit-note issuance failed for refund ${prepared.refundId} (Stripe refund ${stripeRefund.value.id} succeeded — ops follow up via out-of-band-refund runbook)`,
      extraPayload: {
        processor_refund_id: stripeRefund.value.id,
        f4_detail: finalizeResult.error.detail,
      },
    });
    return err({ code: 'f4_bridge_error', detail: finalizeResult.error.detail });
  }

  // T141 metric: refund → CN throughput. AFTER the Phase B tx commits so
  // a rollback (caught above) does not bump the counter.
  // A.9 review fix (#1): gate on `siblingWon === false` — when a
  // concurrent writer (A.11's webhook consumer) already finalised this
  // refund first, THAT writer owns the increment; counting it here too
  // would double-book `refundSucceededCount` for a single refund.
  if (!finalizeResult.value.siblingWon) {
    paymentsMetrics.refundSucceededCount(input.tenantId);
  }

  const completedAt = new Date(deps.clock.nowMs());
  return ok({
    kind: 'succeeded',
    refund: {
      id: prepared.refundId,
      paymentId,
      invoiceId: prepared.payment.invoiceId,
      amountSatang: input.amountSatang,
      reason: input.reason,
      status: 'succeeded',
      processorRefundId: stripeRefund.value.id,
      creditNoteId: finalizeResult.value.creditNoteId,
      creditNoteNumber: finalizeResult.value.creditNoteNumber,
      completedAt: completedAt.toISOString(),
    },
    payment: {
      id: paymentId,
      status: nextPaymentStatus,
      refundedAmountSatang: newSucceededSum,
      // F5R3 H-5 — branded arithmetic; subSatang throws on underflow
      // which is impossible here (isFullyRefunded gate above).
      remainingRefundableSatang: isFullyRefunded
        ? asSatang(0n)
        : subSatang(prepared.payment.amountSatang, newSucceededSum),
    },
    invoice: {
      id: prepared.payment.invoiceId,
      // tax#5 (B.2): F4-AUTHORITATIVE — the shared helper sourced this from
      // F4's post-CN invoice status (`getInvoiceStatus`), not the F5 payment
      // arithmetic, so a pre-existing manual F4 credit note is reflected.
      status: finalizeResult.value.invoiceStatus,
    },
  });
}
