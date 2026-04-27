/**
 * T130 — `processChargeRefunded` use-case (post-audit G1).
 *
 * Handles the Stripe `charge.refunded` webhook branch. Stripe semantics:
 * the event carries one or more `refunds.data[].id` references. Each
 * refund id either:
 *
 *   (a) **MATCHES an in-app `refunds(processor_refund_id)` row** — the
 *       refund was initiated by `issueRefund` (T108), which already
 *       updated `Payment.status` synchronously when Stripe's
 *       `refunds.create` returned. The webhook is the eventual-
 *       consistency confirmation. We finalise `refunds.status='succeeded'`
 *       + `completed_at` if still `pending`; otherwise no-op (idempotent).
 *
 *   (b) **DOES NOT match any in-app refund** — the refund was initiated
 *       outside our app (admin used the Stripe Dashboard, FR-011a). We
 *       emit `out_of_band_refund_detected` audit + bump
 *       `out_of_band_refund_rejected_total` metric (counter wired at the
 *       caller) + alert via `runbook_url` payload field. We do NOT issue
 *       an F4 credit note — the admin must reconcile manually per the
 *       `docs/runbooks/out-of-band-refund.md` runbook.
 *
 * Both branches return ok + finalise `processor_events.markProcessed` in
 * the same `withTx` for atomic commit (Architect D-03 LOW closed
 * 2026-04-24 — `markProcessed` folded into the same tx as the audit
 * writes; a Postgres double-fault rolls back BOTH so the webhook retries
 * see the row as still-unprocessed).
 *
 * Refactor history (2026-04-27, T130 / Phase 9 polish):
 *   - Extracted from inline `case 'charge.refunded':` branch in
 *     `process-webhook-event.ts:420-485` for symmetry with the other
 *     dispatch branches (`confirm-payment.ts`, `fail-payment.ts`,
 *     `handle-cancel-event.ts`) and to make T130a stale-pending-refund
 *     extension landable in a single small file rather than further
 *     bloating the dispatcher.
 *   - Behaviour-preserving: existing 19+ unit tests in
 *     `process-webhook-event.test.ts` covering known/unknown/empty refund
 *     paths + tx-rollback continue to pass against the new composition.
 *   - Adds `process-charge-refunded.test.ts` with 100% branch coverage
 *     against the extracted use-case directly (no mock dispatcher
 *     scaffolding needed).
 *
 * PII / SAQ-A: payload carries `processor_refund_id` (Stripe ref) +
 * `processor_charge_id` (Stripe ref) + `amount_satang` only. NO card
 * metadata, NO last4, NO PAN, NO Stripe-Signature. Constitution
 * Principle IV (NON-NEGOTIABLE).
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  PaymentsRepo,
  ProcessorEventsRepo,
  RefundsRepo,
} from '../ports';
import { retentionFor } from '../ports/audit-port';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { paymentsMetrics } from '@/lib/metrics';

const RUNBOOK_URL = 'docs/runbooks/out-of-band-refund.md';

export interface ProcessChargeRefundedInput {
  readonly tenantId: string;
  readonly requestId: string | null;
  /** Stripe `event.id` for atomic markProcessed inside the dispatch tx. */
  readonly eventId: string;
  /** Stripe `charge.id` (`event.data.object.id`). */
  readonly chargeId: string;
  /** All `event.data.object.refunds.data[].id` values, in payload order. */
  readonly refundIds: readonly string[];
  /** Charge amount in satang (`event.data.object.amount` projected by adapter). */
  readonly amountSatang: bigint;
  /**
   * Stripe `event.livemode` projected to processor-env label. Powers the
   * T141 `out_of_band_refund_rejected_total{tenant, processor_env}`
   * counter so dashboards can split test-mode noise from live-mode
   * forensics (FR-011a alert pivots on live-mode only).
   */
  readonly processorEnv: 'test' | 'live';
}

/**
 * Outcome shape mirrors what the dispatcher injects into
 * `ProcessWebhookEventOutcome` for the `processed` variant of
 * `charge.refunded` events. `invoiceId` is set when AT LEAST ONE refund id
 * matched a DB row (Stripe semantics: all refunds in a single event belong
 * to the SAME charge → SAME PaymentIntent → SAME invoice, so reading the
 * first match is sufficient). Undefined when ALL refund ids were out-of-
 * band (no DB rows to derive an invoice from).
 */
export interface ProcessChargeRefundedSuccess {
  readonly invoiceId?: string;
}

/**
 * Single error class mirrors the dispatcher's `dispatch_threw` mapping.
 * The dispatcher converts this into `ProcessWebhookEventError` with
 * `kind: 'dispatch_threw'` so existing route-level error handling is
 * unchanged.
 */
export type ProcessChargeRefundedError = {
  readonly code: 'dispatch_failed';
  /** Original thrown value — caller stringifies via formatDispatchErrorDetail. */
  readonly cause: unknown;
};

export interface ProcessChargeRefundedDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly refundsRepo: RefundsRepo;
  readonly processorEventsRepo: ProcessorEventsRepo;
  readonly audit: AuditPort;
}

export async function processChargeRefunded(
  deps: ProcessChargeRefundedDeps,
  input: ProcessChargeRefundedInput,
): Promise<
  Result<ProcessChargeRefundedSuccess, ProcessChargeRefundedError>
> {
  // R5 I3 (2026-04-25): capture the affected invoice id from the FIRST
  // found refund so the route handler can fire surgical
  // `revalidatePath('/portal/invoices/<id>')` instead of busting every
  // invoice's cache via the broad `[invoiceId]` pattern. Stripe semantics:
  // all refunds in a single `charge.refunded` event belong to the SAME
  // charge → same PaymentIntent → same invoice, so reading the first
  // DB-existing refund is sufficient.
  let refundedInvoiceId: string | undefined;
  try {
    await deps.paymentsRepo.withTx(async (tx) => {
      for (const refundId of input.refundIds) {
        const existing = await deps.refundsRepo.findByProcessorRefundId(
          tx,
          input.tenantId,
          refundId,
        );
        if (existing && refundedInvoiceId === undefined) {
          refundedInvoiceId = existing.invoiceId;
        }
        // H-1 (review 2026-04-27): if `issueRefund`'s Phase B
        // double-faulted, the in-app row stays `pending` and the
        // webhook is the natural reconciliation point — flip it to
        // `succeeded` here so the stale-pending sweep cron does not
        // later mark it `failed` for a refund Stripe already confirmed.
        // Optimistic-concurrency guard via `expectedCurrentStatus`:
        // a concurrent writer that already finalised the row to
        // `succeeded`/`failed` is left alone (idempotent webhook).
        if (existing && existing.status === 'pending') {
          await deps.refundsRepo.updateStatus(tx, {
            refundId: existing.id,
            tenantId: input.tenantId,
            nextStatus: 'succeeded',
            processorRefundId: refundId,
            completedAt: new Date(),
            expectedCurrentStatus: 'pending',
          });
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'refund_succeeded',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Webhook-driven recovery: pending refund ${existing.id} flipped to succeeded after charge.refunded delivery (Phase B catch-up)`,
            payload: {
              refund_id: existing.id,
              processor_refund_id: refundId,
              processor_charge_id: input.chargeId,
              recovery_path: 'webhook_charge_refunded',
            },
            retentionYears: retentionFor('refund_succeeded'),
          });
          // R2 M-1 (2026-04-27): metric fires INSIDE tx — same trade-off
          // as `outOfBandRefundRejected` below (line ~198). OTel buffers
          // the write until process-boundary flush, so a tx rollback
          // produces at most a tiny over-count window. Moving outside
          // would silently drop on early-return / control-flow exits
          // inside the multi-branch webhook loop. Documented divergence
          // from `issueRefund` (which has linear control flow + emits
          // post-commit). Acceptable per observability.md § 21.3.
          paymentsMetrics.refundSucceededCount(input.tenantId);
        }
        if (!existing) {
          // Branch (b) — out-of-band refund detected. Audit + runbook url.
          // No F4 credit note created (FR-011a — admin must reconcile via
          // Stripe Dashboard + manual CN issuance).
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'out_of_band_refund_detected',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Out-of-band refund detected on charge ${input.chargeId}`,
            payload: {
              processor_refund_id: refundId,
              processor_charge_id: input.chargeId,
              amount_satang: input.amountSatang.toString(),
              runbook_url: RUNBOOK_URL,
            },
            retentionYears: retentionFor('out_of_band_refund_detected'),
          });
          // T141 metric: per-tenant + per-env OOB-refund counter feeds
          // alert rule `out_of_band_refund_rejected_total > 0 / day`
          // (observability.md §21.3). Emitted INSIDE the tx so a
          // dispatch rollback (markProcessed failure) does not leave
          // orphan metric counts; OTel buffers writes until process
          // boundary flush — practical effect is a tiny over-count
          // window if the tx rolls back, acceptable trade-off vs the
          // post-tx alternative which would silently drop on early
          // returns inside the loop.
          paymentsMetrics.outOfBandRefundRejected(
            input.tenantId,
            input.processorEnv,
          );
        }
        // Branch (a) — known refund: in-app `issueRefund` already
        // synchronously updated state when Stripe's refunds.create
        // returned, OR the optional flip just above recovered a
        // double-faulted Phase B. Either way, this branch is now a
        // no-op (idempotent webhook).
      }
      // Atomic with the audit writes above (Architect D-03 LOW).
      // Postgres double-fault rolls back BOTH the audits + markProcessed,
      // so the webhook retry sees the row as still-unprocessed.
      await deps.processorEventsRepo.markProcessed(tx, input.eventId);
    });
  } catch (e) {
    // Stripe error messages can carry partial API key fragments / internal
    // ids — never include `e.message` in the returned error. The
    // dispatcher (process-webhook-event.ts) maps this to `dispatch_threw`
    // and stringifies via `formatDispatchErrorDetail` (constructor-name only).
    return err({ code: 'dispatch_failed' as const, cause: e });
  }
  return ok(
    refundedInvoiceId !== undefined
      ? { invoiceId: refundedInvoiceId }
      : {},
  );
}
