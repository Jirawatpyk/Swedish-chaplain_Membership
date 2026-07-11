/**
 * PR-A Task A.11 — `processRefundUpdated` use-case (bugs #1 reconcile, #2).
 *
 * Handles the Stripe `charge.refund.updated` webhook — the async
 * refund-lifecycle event that fires as a `Refund` object transitions
 * `pending → succeeded | failed | canceled`. `issueRefund` (#1) now leaves
 * an async refund row `pending` at creation time (with its
 * `processor_refund_id` attached, A.6/#2); THIS use-case is the eventual-
 * consistency finaliser that resolves that row by the real Stripe outcome.
 *
 * All work runs inside ONE `withTx`; every outcome branch folds
 * `markProcessed(tx, eventId)` into that same tx (idempotent webhook
 * processing — a Postgres double-fault rolls back the state change AND the
 * markProcessed so Stripe's retry sees the row as still-unprocessed).
 *
 * Outcome map (dispatch on `refundStatus` + the DB refund/auto-refund state):
 *
 *   refund row FOUND (`lockForUpdateByProcessorRefundId`):
 *     - status ≠ pending (already terminal) ....... `already_finalized`
 *     - status = pending + incoming succeeded ..... `reconciled_succeeded`
 *         (via the shared `finalizeSucceededRefund`, `path:
 *          'webhook_refund_updated'`; a sibling-won null-race →
 *          `already_finalized`)
 *     - status = pending + incoming failed/canceled `reconciled_failed`
 *         (flip refund→failed; NO credit note — no §86/4 receipt to reduce)
 *     - status = pending + incoming pending/other .. `still_pending`
 *
 *   refund row NOT FOUND:
 *     - a durable auto-refund marker matches (A.6 `findAutoRefund…`):
 *         · incoming succeeded/pending .............. `auto_refund_recognized`
 *             (suppress the FALSE out-of-band alert — the money-trail was
 *              already recorded at `payment_auto_refunded_stale_invoice`;
 *              audit-SILENT, PCI-clean ops log only)
 *         · incoming failed/canceled ................ `auto_refund_failed`
 *             (CRITICAL-2 — Stripe says the auto-refund did NOT reach the
 *              customer while the payment reads `auto_refunded`; emit the
 *              10y `auto_refund_failed_needs_manual_reconcile` forensic,
 *              NEVER suppressed)
 *     - no marker ................................... `out_of_band`
 *         (genuine Stripe-Dashboard refund we never recorded)
 *
 * Errors (Result.err, never a throw escaping the Application layer): a DB
 * throw OR an F4 credit-note bridge decline on the succeeded path returns
 * `{ code: 'dispatch_failed' }` and leaves the event UNmarked → the
 * dispatcher maps it to `dispatch_threw` → Stripe retries; the A.14
 * Stripe-aware sweep is the ultimate backstop. On an F4 decline we do NOT
 * mark the refund failed — Stripe DEFINITIVELY confirmed `succeeded`, so a
 * `failed` flip would be a money-lie.
 *
 * PCI SAQ-A (Principle IV): every audit payload + log carries id-refs +
 * status + satang ONLY — no card metadata, no raw event, no error.message.
 *
 * Pure Application — no framework / ORM imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  InvoicingBridgePort,
  LoggerPort,
  PaymentsRepo,
  ProcessorEventsRepo,
  RefundsRepo,
} from '../ports';
import { retentionFor } from '../ports/audit-port';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { finalizeSucceededRefund } from './_finalize-succeeded-refund';
import { paymentsMetrics } from '@/lib/metrics';

const OOB_RUNBOOK_URL = 'docs/runbooks/out-of-band-refund.md';

export interface ProcessRefundUpdatedInput {
  readonly tenantId: string;
  readonly requestId: string | null;
  /** Stripe `event.id` — folded into `markProcessed` inside the dispatch tx. */
  readonly eventId: string;
  /** Stripe Refund id `re_…` (`event.data.object.id`) — the match key. */
  readonly processorRefundId: string;
  /** Stripe charge id (`re_…`.charge) — forensic ref on the OOB audit. */
  readonly chargeId: string | null;
  /** Projected Stripe Refund `status` (`pending|succeeded|failed|canceled|requires_action`). */
  readonly refundStatus: string | null;
  /** Refund amount in satang (verifier projection); OOB audit + metric only. */
  readonly amountSatang: bigint;
  /** `event.livemode` → env label for the OOB per-env counter. */
  readonly processorEnv: 'test' | 'live';
}

export type ProcessRefundUpdatedOutcome =
  | {
      readonly kind: 'reconciled_succeeded';
      readonly invoiceId: string;
      readonly creditNoteId: string;
      readonly creditNoteNumber: string;
    }
  | { readonly kind: 'reconciled_failed'; readonly invoiceId: string }
  | { readonly kind: 'already_finalized'; readonly invoiceId: string }
  | { readonly kind: 'still_pending'; readonly invoiceId: string }
  | { readonly kind: 'out_of_band' }
  | { readonly kind: 'auto_refund_recognized'; readonly invoiceId: string }
  | { readonly kind: 'auto_refund_failed'; readonly invoiceId: string };

/**
 * Single error class mirrors `processChargeRefunded` — the dispatcher maps
 * this to `dispatch_threw` (transient) and stringifies the cause via
 * `formatDispatchErrorDetail` (constructor-name only, PCI-clean).
 */
export type ProcessRefundUpdatedError = {
  readonly code: 'dispatch_failed';
  readonly cause: unknown;
};

export interface ProcessRefundUpdatedDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly refundsRepo: RefundsRepo;
  readonly processorEventsRepo: ProcessorEventsRepo;
  readonly invoicingBridge: InvoicingBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /** Optional structured logger for the audit-silent recognition trace. */
  readonly logger?: LoggerPort;
}

/**
 * Sentinel thrown to roll back the dispatch tx when the F4 credit-note
 * bridge declines on the succeeded path (see file docstring). The
 * dispatcher only reads `constructor.name`, so no PII leaks.
 */
class WebhookRefundFinalizeError extends Error {
  constructor(readonly detail: string) {
    super('webhook refund finalize failed');
    this.name = 'WebhookRefundFinalizeError';
  }
}

/**
 * Classify the incoming Stripe refund status into the three transition
 * classes. Anything non-terminal (`pending`, `requires_action`, an
 * unexpected string, or `null`) maps to `'pending'` — the safe default:
 * NEVER finalise (book a CN or mark failed) on a non-terminal status.
 *
 * The `'failed'` arm carries the CONCRETE terminal status (`'failed' |
 * 'canceled'`, always non-null) so the failure branches can build their
 * reason code + audit `refund_status` without a `?? 'unknown'` fallback
 * that would be dead code (null never reaches the failed arm).
 */
type IncomingRefundClass =
  | { readonly kind: 'succeeded' }
  | { readonly kind: 'failed'; readonly status: 'failed' | 'canceled' }
  | { readonly kind: 'pending' };
function classifyIncoming(status: string | null): IncomingRefundClass {
  if (status === 'succeeded') return { kind: 'succeeded' };
  if (status === 'failed' || status === 'canceled') {
    return { kind: 'failed', status };
  }
  return { kind: 'pending' };
}

export async function processRefundUpdated(
  deps: ProcessRefundUpdatedDeps,
  input: ProcessRefundUpdatedInput,
): Promise<Result<ProcessRefundUpdatedOutcome, ProcessRefundUpdatedError>> {
  const incoming = classifyIncoming(input.refundStatus);
  try {
    const outcome = await deps.paymentsRepo.withTx(
      async (tx): Promise<ProcessRefundUpdatedOutcome> => {
        // Lock the refund row by its Stripe id — serialises concurrent
        // reconcilers (a racing sweep or a duplicate webhook) on the same
        // refund. First lock in the tx → establishes the refund-row →
        // payment-row acquisition order (deadlock analysis in the report).
        const refund = await deps.refundsRepo.lockForUpdateByProcessorRefundId(
          tx,
          input.tenantId,
          input.processorRefundId,
        );

        // ------------------------------------------------------------------
        // NOT FOUND — auto-refund reconciliation OR genuine out-of-band.
        // ------------------------------------------------------------------
        if (refund === null) {
          const autoRefund =
            await deps.paymentsRepo.findAutoRefundByProcessorRefundId(
              tx,
              input.tenantId,
              input.processorRefundId,
            );

          if (autoRefund !== null) {
            if (incoming.kind === 'failed') {
              // CRITICAL-2 — the auto-refund did NOT reach the customer.
              // Emit the 10y forensic (money-not-returned). NEVER suppress.
              await deps.audit.emit(tx, {
                tenantId: input.tenantId,
                requestId: input.requestId,
                eventType: 'auto_refund_failed_needs_manual_reconcile',
                actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
                summary: `Auto-refund ${input.processorRefundId} settled ${incoming.status} on payment ${autoRefund.paymentId} — money not returned; manual reconciliation required`,
                payload: {
                  payment_id: autoRefund.paymentId,
                  invoice_id: autoRefund.invoiceId,
                  auto_refund_processor_refund_id: input.processorRefundId,
                  refund_status: incoming.status,
                  amount_satang: input.amountSatang.toString(),
                  runbook_url: OOB_RUNBOOK_URL,
                },
                retentionYears: retentionFor(
                  'auto_refund_failed_needs_manual_reconcile',
                ),
              });
              // A.16 (H-e) — paging counter for the money-not-returned path.
              // Fires INSIDE the tx (same trade-off as `outOfBandRefundRejected`
              // below): OTel buffers until process-flush, so a tx rollback yields
              // at most a tiny over-count window; consistency with the forensic
              // audit above matters more than that window.
              paymentsMetrics.autoRefundFailedNeedsReconcile(input.tenantId);
              await deps.processorEventsRepo.markProcessed(tx, input.eventId);
              return {
                kind: 'auto_refund_failed',
                invoiceId: autoRefund.invoiceId,
              };
            }

            // succeeded | pending → the auto-refund confirmation arrived as
            // expected. Suppress the FALSE out-of-band alert — the
            // money-trail was already audited at
            // `payment_auto_refunded_stale_invoice` (A.13). Audit-SILENT;
            // a PCI-clean ops log gives operators the arrival trace.
            deps.logger?.info(
              'process_refund_updated.auto_refund_recognized',
              {
                tenantId: input.tenantId,
                paymentId: autoRefund.paymentId,
                invoiceId: autoRefund.invoiceId,
                processorRefundId: input.processorRefundId,
                refundStatus: input.refundStatus,
              },
            );
            await deps.processorEventsRepo.markProcessed(tx, input.eventId);
            return {
              kind: 'auto_refund_recognized',
              invoiceId: autoRefund.invoiceId,
            };
          }

          // No in-app refund AND no auto-refund marker → genuine
          // Dashboard-initiated refund (FR-011a). Emit the forensic +
          // per-env counter; NO credit note (admin reconciles via runbook).
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'out_of_band_refund_detected',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Out-of-band refund detected via charge.refund.updated on charge ${input.chargeId ?? 'unknown'}`,
            payload: {
              processor_refund_id: input.processorRefundId,
              // The `out_of_band_refund_detected` payload requires a string;
              // the verifier defaults `latestChargeId` to null only when a
              // Refund's `charge` field is unextractable (pathological). Use
              // an explicit sentinel over a misleading value (mirrors the
              // dispute branch's amountProjectionFailed philosophy).
              processor_charge_id: input.chargeId ?? 'unknown',
              amount_satang: input.amountSatang.toString(),
              runbook_url: OOB_RUNBOOK_URL,
            },
            retentionYears: retentionFor('out_of_band_refund_detected'),
          });
          // Metric fires INSIDE the tx — same trade-off documented in
          // `process-charge-refunded.ts`: OTel buffers until process-flush,
          // so a tx rollback produces at most a tiny over-count window.
          paymentsMetrics.outOfBandRefundRejected(
            input.tenantId,
            input.processorEnv,
          );
          await deps.processorEventsRepo.markProcessed(tx, input.eventId);
          return { kind: 'out_of_band' };
        }

        // ------------------------------------------------------------------
        // FOUND but already terminal — idempotent no-op.
        // ------------------------------------------------------------------
        if (refund.status !== 'pending') {
          await deps.processorEventsRepo.markProcessed(tx, input.eventId);
          return { kind: 'already_finalized', invoiceId: refund.invoiceId };
        }

        // ------------------------------------------------------------------
        // FOUND + pending — finalise by the incoming status.
        // ------------------------------------------------------------------
        if (incoming.kind === 'succeeded') {
          // Shared finaliser in WEBHOOK mode (omit `paymentNextStatus`):
          // idempotent F4 CN + refund flip (expectedCurrentStatus guard) +
          // SB-1 self-lock/aggregate/recovery of the payment.
          const finalized = await finalizeSucceededRefund(deps, tx, {
            refundId: refund.id,
            tenantId: input.tenantId,
            paymentId: refund.paymentId,
            invoiceId: refund.invoiceId,
            amountSatang: refund.amountSatang,
            reason: refund.reason,
            processorRefundId: input.processorRefundId,
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            requestId: input.requestId,
            path: 'webhook_refund_updated',
          });
          if (!finalized.ok) {
            // F4 credit-note bridge declined. Stripe DEFINITIVELY confirmed
            // succeeded, so we must NOT mark the refund failed. Throw to roll
            // back the whole tx (NO markProcessed) → Stripe retries; the CN
            // bridge is idempotent so the retry reconciles cleanly, and the
            // A.14 sweep is the last-resort backstop.
            throw new WebhookRefundFinalizeError(finalized.error.code);
          }
          await deps.processorEventsRepo.markProcessed(tx, input.eventId);
          if (finalized.value.siblingWon) {
            // A concurrent writer finalised this refund first — the CN +
            // payment flip + `refund_succeeded` audit AND the
            // `refundSucceededCount` increment are already theirs; do NOT
            // double-count (mirror issue-refund's `siblingWon===false` gate).
            return { kind: 'already_finalized', invoiceId: refund.invoiceId };
          }
          // THIS writer performed the genuine flip → it owns the
          // finalize-once metric (gated on `siblingWon===false`).
          paymentsMetrics.refundSucceededCount(input.tenantId);
          return {
            kind: 'reconciled_succeeded',
            invoiceId: refund.invoiceId,
            creditNoteId: finalized.value.creditNoteId,
            creditNoteNumber: finalized.value.creditNoteNumber,
          };
        }

        if (incoming.kind === 'failed') {
          // Stripe settled the refund failed/canceled — flip the pending row
          // to `failed` (NO CN: no §86/4 receipt was reduced) + forensic
          // audit, inline in this tx (issue-refund's `finaliseFailedRefund`
          // opens its OWN tx, which would break the one-tx + markProcessed
          // atomicity guarantee). The row is FOR-UPDATE-locked above and read
          // as `pending`, so a plain throw-on-zero updateStatus is correct.
          const failureReasonCode = `stripe_refund_${incoming.status}`;
          const completedAt = new Date(deps.clock.nowMs());
          await deps.refundsRepo.updateStatus(tx, {
            refundId: refund.id,
            tenantId: input.tenantId,
            nextStatus: 'failed',
            failureReasonCode,
            processorRefundId: input.processorRefundId,
            completedAt,
          });
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'refund_failed',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Refund ${refund.id} settled ${incoming.status} via charge.refund.updated (${input.processorRefundId})`,
            payload: {
              refund_id: refund.id,
              payment_id: refund.paymentId,
              invoice_id: refund.invoiceId,
              failure_reason_code: failureReasonCode,
              processor_refund_id: input.processorRefundId,
            },
            retentionYears: retentionFor('refund_failed'),
          });
          // Metric inside the tx (process-charge-refunded precedent).
          paymentsMetrics.refundFailedCount(input.tenantId, failureReasonCode);
          await deps.processorEventsRepo.markProcessed(tx, input.eventId);
          return { kind: 'reconciled_failed', invoiceId: refund.invoiceId };
        }

        // incoming.kind === 'pending' — still in flight; leave the row
        // pending. markProcessed (Stripe stops re-delivering THIS event); a
        // later terminal `charge.refund.updated` — or the A.14 sweep —
        // finalises.
        await deps.processorEventsRepo.markProcessed(tx, input.eventId);
        return { kind: 'still_pending', invoiceId: refund.invoiceId };
      },
    );
    return ok(outcome);
  } catch (e) {
    // Never leak Stripe/Postgres error text (partial keys / row data). The
    // dispatcher maps this to `dispatch_threw` + stringifies via
    // `formatDispatchErrorDetail` (constructor-name only).
    return err({ code: 'dispatch_failed' as const, cause: e });
  }
}
