/**
 * PR-A Task A.11 — `processRefundUpdated` use-case (bugs #1 reconcile, #2).
 *
 * Handles Stripe's refund-lifecycle webhooks — the async refund events that
 * fire as a `Refund` object transitions `pending → succeeded | failed |
 * canceled`. The dispatcher routes BOTH the deprecated `charge.refund.updated`
 * (fires only for refunds WITH a legacy charge) AND the forward-path
 * `refund.updated` (PR-A follow-up, 2026-07-12 — fires for ALL refunds incl.
 * charge-less async PromptPay/GrabPay/bank-transfer settlements) to this ONE
 * use-case; it is event-type-agnostic (keys on `processorRefundId` +
 * `refundStatus`, with `sourceEventType` carried only for the forensic
 * summary). `issueRefund` (#1) now leaves
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
 *          `already_finalized`; a PERMANENT F4 credit-note decline →
 *          `reconciled_cn_deferred` — 8C, terminalise the event, leave the row
 *          pending; a TRANSIENT decline still throws → `dispatch_failed`/retry)
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
import { proveProcessorSettledFailed } from '../../domain/settlement/money-moved';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { finalizeSucceededRefund } from './_finalize-succeeded-refund';
import { recogniseAppInitiatedRefund } from './_recognise-app-initiated-refund';
import { paymentsMetrics } from '@/lib/metrics';
import type { Satang } from '@/lib/money';
// 8C — the F4 CREDIT-NOTE error union (distinct from RecordPaymentError, which
// `classifyDispatchPermanence` covers for the record-payment rail). Used only
// to key the exhaustive permanence table below, so a NEW F4 CN code is a BUILD
// failure here rather than a silent default.
import type { IssueCreditNoteError } from '@/modules/invoicing';

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
  /**
   * PR-A follow-up (2026-07-12) — the concrete Stripe event type that
   * carried this settlement (`charge.refund.updated` | `refund.updated`).
   * Interpolated into the OOB / refund_failed forensic summaries so a
   * 10-year audit row names the REAL channel instead of a hardcoded event
   * type (the codebase's "no known-wrong value in a retained forensic"
   * discipline). Optional so existing callers/tests that omit it keep the
   * historical `charge.refund.updated` wording; the dispatcher always
   * threads the real `event.type`.
   */
  readonly sourceEventType?: string;
  /**
   * Refund amount in satang (verifier projection); OOB audit + metric only.
   * Branded `Satang` to keep money-type discipline uniform across F5 even
   * though this value is forensic-only (never arithmetic-folded here).
   */
  readonly amountSatang: Satang;
  /**
   * Round-2 review fix (#32) — true iff the verifier's amount projection failed
   * (malformed / NaN / fractional / missing Refund `amount`). When true the
   * 10-year OOB / auto-refund-failed forensics write the `'projection_failed'`
   * sentinel for `amount_satang` instead of a known-wrong `0` — mirrors the
   * dispute branch's F5R3v3 H-4 discipline. Optional; defaults false.
   */
  readonly amountProjectionFailed?: boolean;
  /** `event.livemode` → env label for the OOB per-env counter. */
  readonly processorEnv: 'test' | 'live';
  /**
   * Money-remediation Task 9 (F-9) — this Refund's app-initiated marker
   * (`metadata.refundId`), stamped by `issueRefund` BEFORE the external call
   * and format-validated at the verifier. Absent for a genuine
   * Stripe-Dashboard refund, in which case the OOB forensic fires unchanged.
   */
  readonly appRefundId?: string;
  /**
   * Money-remediation Task 9 (F-9) — the Refund's PaymentIntent id, used ONLY
   * for the anti-forgery cross-check. Absent or null makes the check
   * unsatisfiable, which must NOT suppress.
   */
  readonly paymentIntentId?: string | null;
}

export type ProcessRefundUpdatedOutcome =
  | {
      readonly kind: 'reconciled_succeeded';
      readonly invoiceId: string;
      /** Track B — NULL when the refund owed no §86/10 (waived). */
      readonly creditNoteId: string | null;
      readonly creditNoteNumber: string | null;
    }
  | { readonly kind: 'reconciled_failed'; readonly invoiceId: string }
  | { readonly kind: 'already_finalized'; readonly invoiceId: string }
  | { readonly kind: 'still_pending'; readonly invoiceId: string }
  | { readonly kind: 'out_of_band' }
  | { readonly kind: 'auto_refund_recognized'; readonly invoiceId: string }
  | { readonly kind: 'auto_refund_failed'; readonly invoiceId: string }
  /**
   * F-9 (Task 9) — the refund was recognised by its app-initiated marker and
   * `processor_refund_id` was back-filled. DISTINCT from `still_pending`: the
   * row is left pending on purpose, but the meaningful event is the repair that
   * makes it matchable again. Deliberately NOT finalised here — see the
   * suppression block for why.
   */
  | { readonly kind: 'app_refund_backfilled'; readonly invoiceId: string }
  /**
   * 8C — the refund settled at Stripe but its F4 credit note is PERMANENTLY
   * un-bookable (e.g. `credit_exceeds_remainder`). The WEBHOOK EVENT is
   * finalised (markProcessed + a 10y `refund_cn_deferred` forensic) so Stripe
   * stops the 72h retry storm; the refund ROW is left `pending` for accountant
   * reconciliation (no terminal row-state exists for "money moved, CN owed but
   * un-bookable" — the sweep and 8A carry the row side). Carries `invoiceId`,
   * so the dispatcher's `'invoiceId' in value` forwards it unchanged.
   */
  | { readonly kind: 'reconciled_cn_deferred'; readonly invoiceId: string };

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

/**
 * 8C — is an F4 credit-note-bridge decline PERMANENT (retry is futile) as it
 * arrives on the refund-updated webhook rail?
 *
 * A total `Record` over `IssueCreditNoteError['code']` so a NEW F4 CN code is a
 * BUILD failure here, not a silent default. Conservative bias (HARD
 * CONSTRAINT): terminalising a TRANSIENT decline would lose a recoverable
 * refund's §86/10 credit note, so ONLY proven-permanent codes are `true`; the
 * `?? false` fallback keeps any unknown/malformed code (e.g. summariseF4Error's
 * 'f4_error'/'bridge_error') TRANSIENT — a bounded, logged retry the operator
 * sees, never a silent terminalisation. Every verdict is justified against
 * `issue-credit-note.ts`'s error union.
 */
const PERMANENT_CN_DECLINE: Readonly<Record<IssueCreditNoteError['code'], boolean>> = {
  credit_exceeds_remainder: true, // remainder permanently exhausted — never clears
  invoice_not_found: true, // invoice hard-deleted / bad id — will not reappear
  no_snapshot_on_invoice: true, // data-invariant violation — needs an operator
  invalid_event_invoice: true, // data-invariant violation — needs an operator
  receipt_not_creditable: true, // §105 legal verdict — a receipt is NEVER creditable
  settings_missing: true, // F4 config gap — no Stripe retry can supply it
  overflow: true, // §87 sequence exhausted for the FY — needs an operator
  invalid_status: false, // optimistic race indistinguishable from wrong status → retry
  receipt_not_rendered: false, // explicitly "retry once the receipt render completes"
  pdf_render_failed: false, // transient infra
  blob_upload_failed: false, // transient infra
  concurrent_state_change: false, // optimistic-lock race — retry may win
  membership_effect_required: false, // unreachable via refund (bridge hardcodes 'keep')
};

function isPermanentCreditNoteDecline(code: string): boolean {
  return PERMANENT_CN_DECLINE[code as IssueCreditNoteError['code']] ?? false;
}

export async function processRefundUpdated(
  deps: ProcessRefundUpdatedDeps,
  input: ProcessRefundUpdatedInput,
): Promise<Result<ProcessRefundUpdatedOutcome, ProcessRefundUpdatedError>> {
  const incoming = classifyIncoming(input.refundStatus);
  // Round-2 review fix (#32): a retained (10y) forensic must never carry a
  // known-wrong 0. Write the 'projection_failed' sentinel when the verifier
  // flagged the amount projection as failed (mirrors the dispute branch's
  // amountProjectionFailed philosophy in process-webhook-event).
  const amountSatangForAudit = input.amountProjectionFailed
    ? 'projection_failed'
    : input.amountSatang.toString();
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
              // Emit the 10y forensic (money-not-returned). NEVER suppress the
              // AUDIT: like the OOB forensic it is emitted REDUNDANTLY across
              // both charge.refund.updated + refund.updated deliveries (SPOF
              // avoidance — a single-owner emit that failed its whole retry
              // window would leave ZERO durable 10y record) and deduped on READ
              // by `auto_refund_processor_refund_id`. The admin alert reads via
              // a bare EXISTS (findFailedAutoRefundForInvoice), so duplicate
              // forensic rows do not affect the alert/resolve lifecycle.
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
                  amount_satang: amountSatangForAudit,
                  runbook_url: OOB_RUNBOOK_URL,
                },
                retentionYears: retentionFor(
                  'auto_refund_failed_needs_manual_reconcile',
                ),
              });
              // A.16 (H-e) — paging counter for the money-not-returned path.
              // Round-2 review fix (#33): single-owner paging. Stripe delivers
              // BOTH charge.refund.updated (deprecated) AND refund.updated for a
              // charged auto-refund; bumping on both would double-page ONE
              // incident. refund.updated is the forward-path universal event
              // (required subscription, OP-2), so it owns the page; the
              // deprecated charge.refund.updated delivery is suppressed. The 10y
              // forensic above stays redundant (SPOF-safe). Legacy callers/tests
              // that omit sourceEventType keep firing — the guard suppresses ONLY
              // the explicit deprecated event. Fires INSIDE the tx (same trade-
              // off as `outOfBandRefundRejected`): OTel buffers until flush, so a
              // rollback yields at most a tiny over-count window.
              if (input.sourceEventType !== 'charge.refund.updated') {
                paymentsMetrics.autoRefundFailedNeedsReconcile(input.tenantId);
              }
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

          // F-9 (Task 9) — before flagging OOB, consult the app-initiated
          // marker `issueRefund` stamps BEFORE the external call. The lock
          // above keys on `processor_refund_id`, which is written in a SEPARATE
          // tx afterwards, so an admin refund whose attach has not landed (or
          // never landed — `attachProcessorRefundId` throws with no try/catch,
          // stranding the row NULL forever) is invisible to it and fires a
          // FALSE 10-year forensic on every delivery. All four mitigations live
          // in the helper; read its docstring before touching this.
          const recognition = await recogniseAppInitiatedRefund(
            { refundsRepo: deps.refundsRepo, ...(deps.logger ? { logger: deps.logger } : {}) },
            tx,
            {
              tenantId: input.tenantId,
              appRefundId: input.appRefundId,
              processorRefundId: input.processorRefundId,
              paymentIntentId: input.paymentIntentId,
            },
          );
          if (recognition.kind === 'recognised') {
            // Audit-SILENT suppression + PCI-clean ops log, mirroring the
            // auto-refund arm above.
            //
            // NOT finalised in this pass, even though THIS handler owns
            // finalisation (A.11). The row was just back-filled inside this tx;
            // finalising it here would mean re-reading and re-locking a row we
            // have already written in the same tx, duplicating
            // `finalizeSucceededRefund`'s entry conditions on a path with no
            // test coverage for the succeeded/failed split. The back-fill is
            // sufficient and self-healing: Stripe re-delivers this settlement
            // (and `refund.updated` fires again on every transition), and the
            // next delivery matches by `processor_refund_id` through the
            // ordinary FOUND path. The A.14 Stripe-aware sweep — which SKIPS
            // rows with a NULL processor id — is now also able to reconcile it,
            // which it never could before.
            deps.logger?.info('process_refund_updated.app_refund_recognized', {
              tenantId: input.tenantId,
              refundId: recognition.refundId,
              invoiceId: recognition.invoiceId,
              processorRefundId: input.processorRefundId,
              refundStatus: input.refundStatus,
            });
            await deps.processorEventsRepo.markProcessed(tx, input.eventId);
            return {
              kind: 'app_refund_backfilled',
              invoiceId: recognition.invoiceId,
            };
          }
          // Every other outcome — no marker, unresolved, PI mismatch, terminal
          // row — falls through to the forensic BY DESIGN. A forged marker must
          // not buy silence.

          // No in-app refund AND no auto-refund marker → genuine
          // Dashboard-initiated refund (FR-011a). Emit the 10y OOB forensic
          // here, INSIDE the tx (atomic with `markProcessed`). No F4 credit
          // note (admin reconciles via the runbook).
          //
          // Finding 4 (SPLIT ownership — money-trail forensic ⇒ redundancy) —
          // Stripe delivers BOTH `charge.refunded` AND `charge.refund.updated`
          // for the same genuine Dashboard refund. The two emissions have
          // DIFFERENT ownership, on purpose:
          //
          //   · `out_of_band_refund_detected` AUDIT (10y forensic) — emitted
          //     REDUNDANTLY from BOTH handlers (here + `processChargeRefunded`).
          //     A forensic single point of failure would exist if only one
          //     handler emitted: were that handler to fail its ENTIRE retry
          //     window (Stripe retries ~3 days) after the sibling already
          //     `markProcessed`, the 10y money-trail would have ZERO durable
          //     record. Deliberate redundancy removes that SPOF; the duplicate
          //     rows are deduped on READ by `processor_refund_id` (existing
          //     group-by convention), so downstream sees one OOB per refund.
          //   · `outOfBandRefundRejected` METRIC (paging counter) — SINGLE-OWNER
          //     on `processChargeRefunded` FOR REFUNDS THAT HAVE A CHARGE.
          //     `charge.refunded` fires whenever a charge's `amount_refunded`
          //     changes (partial + full + async-refund initiation), so it is the
          //     universal detector for CHARGED refunds; bumping it here too would
          //     double-count them (2× per genuine OOB). EXCEPTION (Fix 1): a
          //     charge-less async refund (PromptPay / GrabPay / bank transfer —
          //     no `charge` object) NEVER fires `charge.refunded`, so it reaches
          //     us ONLY via `refund.updated` and this handler is its SOLE
          //     detector. For that case (`input.chargeId === null`) we DO emit
          //     the metric below so on-call is paged in real time; with-charge
          //     OOBs still page via `charge.refunded` only.
          //
          // Finding 2 suppression (app-initiated auto-refunds) is handled in the
          // NOT-FOUND branch above (autoRefund !== null) and mirrored in
          // `processChargeRefunded`, so neither handler mis-fires the forensic
          // for a refund the app itself initiated.
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'out_of_band_refund_detected',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Out-of-band refund detected via ${input.sourceEventType ?? 'charge.refund.updated'} on charge ${input.chargeId ?? 'unknown'}`,
            payload: {
              processor_refund_id: input.processorRefundId,
              // The `out_of_band_refund_detected` payload requires a string;
              // the verifier defaults `latestChargeId` to null only when a
              // Refund's `charge` field is unextractable (pathological). Use
              // an explicit sentinel over a misleading value (mirrors the
              // dispute branch's amountProjectionFailed philosophy).
              processor_charge_id: input.chargeId ?? 'unknown',
              amount_satang: amountSatangForAudit,
              runbook_url: OOB_RUNBOOK_URL,
            },
            retentionYears: retentionFor('out_of_band_refund_detected'),
          });
          // Paging metric — single-owner on `processChargeRefunded` for refunds
          // that HAVE a charge (do NOT bump here for those: it would double-
          // count). The charge-less case is the exception (Fix 1): no
          // `charge.refunded` will EVER fire for it, so this handler is the sole
          // detector and MUST page or on-call gets the 10y forensic but no
          // real-time alert. Emitted INSIDE the tx (same buffered-until-flush
          // trade-off as the sibling counters): a rollback yields at most a tiny
          // over-count window, and consistency with the forensic audit above
          // matters more than that window.
          //
          // Round-2 review fix (#34): a charge-less async OOB refund settles via
          // MULTIPLE refund.updated deliveries (pending → succeeded, distinct
          // event ids that each pass the per-event-id idempotency insert), so
          // bumping on every delivery would double-page ONE refund. Gate the
          // page on the TERMINAL transition (`incoming.kind !== 'pending'`) — it
          // fires exactly once, at settlement (succeeded or failed). The 10y
          // forensic above still records the detection on every delivery
          // (redundant, deduped on read), so nothing is lost if it never settles.
          if (input.chargeId === null && incoming.kind !== 'pending') {
            paymentsMetrics.outOfBandRefundRejected(
              input.tenantId,
              input.processorEnv,
            );
          }
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
          //
          // INTENT (do NOT "optimise" the lock-hold away): this refund row is
          // held under `FOR NO KEY UPDATE` (locked above) for the FULL duration
          // of `finalizeSucceededRefund`, INCLUDING the external F4 credit-note
          // bridge call (its own tx: PDF render + Blob + §87 sequence). Holding
          // the lock across the CN issuance is DELIBERATE — it serialises
          // duplicate `charge.refund.updated` deliveries on the same `re_…` so
          // exactly one CN is minted (the CN bridge is also idempotent per
          // `(tenant, source_refund_id)`, but the lock is the first line). It is
          // NOT a deadlock risk: the lock strength is `FOR NO KEY UPDATE` (A.18),
          // which permits the CN insert's `FOR KEY SHARE` FK check on this row
          // from the separate bridge connection; and refunds↔credit_notes are
          // DISJOINT tables so no lock-ordering cycle exists.
          const finalized = await finalizeSucceededRefund(deps, tx, {
            refundId: refund.id,
            tenantId: input.tenantId,
            paymentId: refund.paymentId,
            invoiceId: refund.invoiceId,
            amountSatang: refund.amountSatang,
            reason: refund.reason,
            // Track B — read off the refund row, which pinned it in Phase A.
            // REQUIRED by the finaliser, deliberately: defaulting it to `null`
            // here would route a waived refund into the credit-note bridge,
            // which refuses it, leaving a Stripe-settled refund `pending`
            // forever and blocking every future refund on the payment. That is
            // the F-3 shape, recreated. A compile error is the cheaper failure.
            creditNoteWaiverReason: refund.creditNoteWaiverReason,
            processorRefundId: input.processorRefundId,
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            requestId: input.requestId,
            path: 'webhook_refund_updated',
          });
          if (!finalized.ok) {
            const code = finalized.error.code;
            if (isPermanentCreditNoteDecline(code)) {
              // 8C — a PERMANENT F4 decline (e.g. `credit_exceeds_remainder`).
              // Stripe DEFINITIVELY confirmed succeeded (money moved), and
              // retrying the bridge can NEVER clear this code — so throwing
              // would 72h-retry a decline that cannot self-heal. Terminalise
              // the WEBHOOK EVENT instead: a 10-year `refund_cn_deferred`
              // forensic + markProcessed inside this tx, 200-ack. The refund
              // row STAYS `pending` (money moved, CN reconciliation owed) —
              // never flipped `failed` (a money-lie) nor `succeeded` (it holds
              // no CN / waiver), matching the admin-leg deferRefundCreditNote +
              // sweep precedent, and keeping 8A's pending-refund guard armed so
              // no double payout is un-blocked.
              const deferReasonCode = `f4_bridge_${code}`;
              await deps.audit.emit(tx, {
                tenantId: input.tenantId,
                requestId: input.requestId,
                eventType: 'refund_cn_deferred',
                actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
                summary:
                  `Refund ${refund.id} settled at the processor (${input.processorRefundId}) ` +
                  `but the F4 credit note is permanently un-bookable (${deferReasonCode}); ` +
                  `row left pending — accountant reconciliation required`,
                payload: {
                  refund_id: refund.id,
                  payment_id: refund.paymentId,
                  invoice_id: refund.invoiceId,
                  amount_satang: refund.amountSatang.toString(),
                  processor_refund_id: input.processorRefundId,
                  defer_reason_code: deferReasonCode,
                  detail: finalized.error.detail,
                  runbook_url: 'docs/runbooks/stale-pending-refund-sweep.md',
                },
                retentionYears: retentionFor('refund_cn_deferred'),
              });
              // SINGLE-OWNER the operator page: BOTH the deprecated
              // `charge.refund.updated` AND the forward `refund.updated` route
              // here, and 8C leaves the row `pending`, so every delivery
              // re-enters this fork. The 10y forensic above is redundant/
              // SPOF-safe (deduped on read by `processor_refund_id`), but the
              // metric must fire ONCE per charged refund — gate it exactly as
              // the auto_refund_failed page does (`:290`) so `refund.updated`
              // owns it.
              if (input.sourceEventType !== 'charge.refund.updated') {
                paymentsMetrics.refundCreditNoteDeferred(
                  input.tenantId,
                  deferReasonCode,
                );
              }
              await deps.processorEventsRepo.markProcessed(tx, input.eventId);
              return { kind: 'reconciled_cn_deferred', invoiceId: refund.invoiceId };
            }
            // TRANSIENT F4 decline (infra / optimistic race / unknown code).
            // Stripe DEFINITIVELY confirmed succeeded, so we must NOT mark the
            // refund failed. Throw to roll back the whole tx (NO markProcessed)
            // → Stripe retries; the CN bridge is idempotent so the retry
            // reconciles cleanly, and the A.14 sweep is the last-resort backstop.
            throw new WebhookRefundFinalizeError(code);
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
            // NULL on a waived refund — no credit note was owed.
            creditNoteId:
              finalized.value.documentation === 'credit_note'
                ? finalized.value.creditNoteId
                : null,
            creditNoteNumber:
              finalized.value.documentation === 'credit_note'
                ? finalized.value.creditNoteNumber
                : null,
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
            // Stripe itself reported this refund terminally failed/canceled in
            // the webhook payload — the funds went back to the platform
            // balance. That is a proven rejection (money-remediation F-3), on
            // evidence from the processor rather than from a refused request.
            rejectionProof: proveProcessorSettledFailed(incoming.status),
            failureReasonCode,
            processorRefundId: input.processorRefundId,
            completedAt,
          });
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'refund_failed',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Refund ${refund.id} settled ${incoming.status} via ${input.sourceEventType ?? 'charge.refund.updated'} (${input.processorRefundId})`,
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
