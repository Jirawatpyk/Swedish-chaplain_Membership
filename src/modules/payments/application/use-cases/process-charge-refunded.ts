/**
 * T130 — `processChargeRefunded` use-case (post-audit G1).
 *
 * Handles the Stripe `charge.refunded` webhook branch. Stripe semantics:
 * the event carries one or more `refunds.data[].id` references. Each
 * refund id either:
 *
 *   (a) **MATCHES an in-app `refunds(processor_refund_id)` row** — the
 *       refund was initiated by `issueRefund` (T108). Since A.9 attaches
 *       `processor_refund_id` at refund-creation time, this webhook can
 *       now MATCH a still-`pending` row. **A.12 (#2, RR-5): `charge.refunded`
 *       NO LONGER finalises the refund.** Async-refund finalisation (F4
 *       credit note + `refunds.status='succeeded'` flip + parent-payment
 *       flip + parent-recovery + `refund_succeeded` audit) is now SOLELY
 *       owned by `charge.refund.updated` → `processRefundUpdated` (A.11,
 *       `finalizeSucceededRefund`). For a matched `pending` row this branch
 *       runs ONLY the amount-mismatch sanity check (loud audit + skip on
 *       DB/Stripe divergence); otherwise it is a no-op. An already-finalised
 *       (`succeeded`/`failed`) row is an idempotent no-op (duplicate-delivery
 *       counter only).
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
  ClockPort,
  LoggerPort,
  PaymentsRepo,
  ProcessorEventsRepo,
  RefundsRepo,
} from '../ports';
import { retentionFor } from '../ports/audit-port';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { recogniseAppInitiatedRefund } from './_recognise-app-initiated-refund';
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
   * F5R3v3 H-4 (2026-05-16) — `true` iff the webhook verifier's
   * defensive amount projection (C-1) failed for THIS event. When
   * true, `amountSatang` is the `?? 0n` default and MUST NOT be
   * compared against existing refund rows — doing so would flag
   * EVERY pending refund (existing > 0) as
   * `refund_amount_mismatch_detected`, creating an audit storm on a
   * single fuzzed/drifted webhook. Skip the mismatch comparison
   * entirely; out-of-band sweep cron reconciles.
   */
  readonly amountProjectionFailed?: boolean;
  /**
   * Stripe `event.livemode` projected to processor-env label. Powers the
   * T141 `out_of_band_refund_rejected_total{tenant, processor_env}`
   * counter so dashboards can split test-mode noise from live-mode
   * forensics (FR-011a alert pivots on live-mode only).
   */
  readonly processorEnv: 'test' | 'live';
  /**
   * Money-remediation Task 9 (F-9) — app-initiated refund markers for THIS
   * charge, keyed by Stripe refund id (`re_…` → our `refunds.id`), projected
   * from each `refunds.data[i].metadata.refundId`. A charge can carry several
   * refunds that are independently app- or Dashboard-initiated, hence a map.
   *
   * Optional: absent for every pre-Task-9 caller and for any refund with no
   * marker, in which case the OOB forensic fires exactly as before.
   */
  readonly appRefundIds?: Readonly<Record<string, string>>;
  /**
   * Money-remediation Task 9 (F-9) — the charge's PaymentIntent id, used ONLY
   * to cross-check a marker against the matched row's parent payment. Absent
   * or null means the check is unsatisfiable, which must NOT suppress.
   */
  readonly paymentIntentId?: string | null;
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
  /**
   * ClockPort — required for F5 use-case Deps-shape symmetry and threaded
   * by the dispatcher (`process-webhook-event.ts`). A.12 (2026-07-11)
   * removed the pending-flip block that consumed it (`completedAt`), so it
   * is no longer read in this file's body; kept required to preserve the
   * composition-root wiring contract shared across F5 webhook use-cases.
   */
  readonly clock: ClockPort;
  /**
   * Optional structured logger. F5R3 SB-1 wired it here for the
   * parent_status_recovery race-warn; A.12 (2026-07-11) moved that
   * finalisation + recovery to `finalizeSucceededRefund` (A.11), so the
   * warn now lives there. Retained as a reserved, dispatcher-threaded slot
   * (mirrors `process-webhook-event.ts`); no longer read in this body.
   */
  readonly logger?: LoggerPort;
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
  // F5R3 H-3 (2026-05-16) — schema-drift detection: Stripe's
  // `charge.refunded` event ALWAYS carries at least one refund per the
  // API contract. Receiving zero refundIds means the webhook-verifier
  // projection drifted (Stripe API changed, fixture malformed, etc.).
  // Pre-fix the for-loop just silently no-op'd → markProcessed → 200
  // ack → no forensic signal. Now we bump a counter so SRE alerts on
  // sustained empty-payload rate. Still mark processed (Stripe stops
  // retrying) but the schema drift is no longer invisible.
  if (input.refundIds.length === 0) {
    paymentsMetrics.webhookDuplicateIgnored(
      input.tenantId,
      'charge.refunded.empty_refund_ids',
    );
  }
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
        // F5R3 H-3 (2026-05-16) — already-finalised idempotent path:
        // Stripe re-delivered a `charge.refunded` for a refund that
        // our DB has already marked `succeeded` or `failed` (e.g.
        // issueRefund's Phase B happy-path landed BEFORE this
        // webhook arrived, or Stripe re-sent due to its own retry
        // logic). Pre-fix this was a silent no-op — chronic
        // duplicate deliveries from Stripe clock-drift or webhook
        // misconfiguration were invisible. Bump the duplicate
        // counter with a granular event_type so SRE can alert on
        // sustained high duplicate rate (>0.1% of `charge.refunded`
        // throughput = re-delivery anomaly worth paging).
        if (
          existing &&
          (existing.status === 'succeeded' || existing.status === 'failed')
        ) {
          paymentsMetrics.webhookDuplicateIgnored(
            input.tenantId,
            'charge.refunded.already_finalised',
          );
        }
        // A.12 (#2, RR-5, 2026-07-11) — `charge.refunded` NO LONGER
        // finalises a matched `pending` refund row. Async-refund
        // finalisation (F4 credit note + refund→succeeded flip +
        // parent-payment flip + SB-1 parent-recovery + `refund_succeeded`
        // audit) is now SOLELY owned by `charge.refund.updated` →
        // `processRefundUpdated` (A.11), which ported the recovery verbatim
        // into `finalizeSucceededRefund`. A.9 attaches `processor_refund_id`
        // at refund-creation time, so this webhook can now MATCH a `pending`
        // row — but its ONLY remaining job for such a row is the
        // amount-mismatch sanity check below. Removing the former flip also
        // eliminates a latent double-count/double-audit bug: the flip passed
        // `expectedCurrentStatus:'pending'` yet IGNORED the `null` return, so
        // a simultaneous `charge.refunded` + `charge.refund.updated`
        // double-delivery fired a SECOND `refund_succeeded` audit +
        // `refundSucceededCount`.
        if (existing && existing.status === 'pending') {
          // F5R1-E13 / F5R2-SF-6 — amount-mismatch sanity check (still
          // reachable for a matched pending row). If the DB row's amount
          // exceeds the Stripe charge's TOTAL refunded amount, the DB and
          // Stripe have diverged (admin edited the refund via the Stripe
          // Dashboard, or a partial-update bug). Flag it loudly with the
          // dedicated `refund_amount_mismatch_detected` event (migration
          // 0151) so operator dashboards get a clean signal distinct from
          // genuine out-of-band refunds; an admin reconciles per the runbook.
          //
          // FULL per-refund amount invariance requires extending the
          // webhook-verifier projection to emit `refunds.data[i].amount`
          // per refund id (currently only `refundIds: string[]` + total
          // `amountSatang`). Tracked as R2 follow-up — see
          // `specs/009-online-payment/r10-carryover-from-f4.md`.
          //
          // F5R3v3 H-4 (2026-05-16) — skip the comparison when the verifier
          // flagged the amount projection as failed (`input.amountSatang` is
          // the `?? 0n` default, not a real value). Pre-fix every
          // `existing > 0` tripped the mismatch branch → audit storm on a
          // single fuzzed event. The out-of-band sweep cron reconciles the
          // actual amount.
          if (
            !input.amountProjectionFailed &&
            existing.amountSatang > input.amountSatang
          ) {
            await deps.audit.emit(tx, {
              tenantId: input.tenantId,
              requestId: input.requestId,
              eventType: 'refund_amount_mismatch_detected',
              actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
              summary: `Refund amount mismatch: DB row ${existing.id} amount ${existing.amountSatang} satang exceeds Stripe charge total refunded ${input.amountSatang} satang — admin must reconcile`,
              payload: {
                refund_id: existing.id,
                // existing.paymentId is the FK on the refund row to its
                // parent payment — the typed audit payload uses string (not
                // branded) since this is downstream of the Domain boundary.
                payment_id: existing.paymentId,
                db_amount_satang: existing.amountSatang.toString(),
                stripe_amount_satang: input.amountSatang.toString(),
                runbook_url: RUNBOOK_URL,
              },
              retentionYears: retentionFor('refund_amount_mismatch_detected'),
            });
            paymentsMetrics.outOfBandRefundRejected(
              input.tenantId,
              input.processorEnv,
            );
            continue;
          }
          // No mismatch → no-op. The refund row stays `pending`;
          // `charge.refund.updated` (processRefundUpdated) finalises it.
        }
        if (!existing) {
          // Finding 2 (#2 sibling parity) — before flagging OOB, consult the
          // durable app-initiated auto-refund marker. confirm-payment's
          // stale-invoice / late-charge auto-refund (A.13/A.15) stamps
          // `payments.auto_refund_processor_refund_id` and creates NO `refunds`
          // row, so `findByProcessorRefundId` above returned null. Stripe
          // delivers BOTH `charge.refunded` AND `charge.refund.updated` for such
          // an auto-refund; without this guard `charge.refunded` fires a FALSE
          // `out_of_band_refund_detected` (10y forensic) + `outOfBandRefundRejected`
          // paging metric for a refund the app itself initiated. The sibling
          // `charge.refund.updated` handler (`processRefundUpdated`, A.11) already
          // suppresses this exact case via the same lookup — mirror it here.
          const autoRefund =
            await deps.paymentsRepo.findAutoRefundByProcessorRefundId(
              tx,
              input.tenantId,
              refundId,
            );
          if (autoRefund !== null) {
            // Recognised app-initiated auto-refund. The money-trail was already
            // recorded at `payment_auto_refunded_stale_invoice` (A.13) — SUPPRESS
            // the false OOB; audit-SILENT, PCI-clean ops log only. The FAILED-case
            // forensic (`auto_refund_failed_needs_manual_reconcile`) stays SOLELY
            // owned by `charge.refund.updated`: `charge.refunded` carries no
            // per-refund status, so it cannot tell succeeded from failed.
            deps.logger?.info('process_charge_refunded.auto_refund_recognized', {
              tenantId: input.tenantId,
              paymentId: autoRefund.paymentId,
              invoiceId: autoRefund.invoiceId,
              processorRefundId: refundId,
            });
            continue;
          }
          // F-9 (Task 9) — second durable app-initiated marker, same shape as
          // the auto-refund lookup above but keyed on `metadata.refundId`,
          // which `issueRefund` stamps BEFORE the external call. Covers the
          // ADMIN refund path, whose `processor_refund_id` is written in a
          // SEPARATE tx afterwards: a delivery landing in that window (or after
          // the attach failed outright, which strands the row NULL forever)
          // otherwise fires a FALSE 10-year forensic + page for a refund we
          // initiated. All four mitigations live in the helper — read its
          // docstring before touching this, over-suppression is the dangerous
          // direction here.
          const recognition = await recogniseAppInitiatedRefund(
            { refundsRepo: deps.refundsRepo, ...(deps.logger ? { logger: deps.logger } : {}) },
            tx,
            {
              tenantId: input.tenantId,
              appRefundId: input.appRefundIds?.[refundId],
              processorRefundId: refundId,
              paymentIntentId: input.paymentIntentId,
            },
          );
          if (recognition.kind === 'recognised') {
            // Suppress the FALSE OOB. Audit-SILENT + PCI-clean ops log, exactly
            // like the auto-refund arm: the money-trail for this refund was
            // already recorded by `refund_initiated` at Phase A.
            //
            // NO finalisation — `charge.refunded` carries no per-refund status,
            // so it cannot tell succeeded from failed. The back-fill alone
            // restores the row to the ordinary path: the sibling
            // `charge.refund.updated` / `refund.updated` will now match it by
            // `processor_refund_id` and finalise it (A.11/A.12), and the
            // stale-pending sweep can finally see it.
            deps.logger?.info('process_charge_refunded.app_refund_recognized', {
              tenantId: input.tenantId,
              refundId: recognition.refundId,
              invoiceId: recognition.invoiceId,
              processorRefundId: refundId,
            });
            if (refundedInvoiceId === undefined) {
              refundedInvoiceId = recognition.invoiceId;
            }
            continue;
          }
          // Every other recognition outcome — no marker, unresolved, PI
          // mismatch, terminal row — falls through to the forensic BY DESIGN.
          // A forged marker must not buy silence.

          // Branch (b) — genuine out-of-band refund detected. Audit + runbook url.
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
        // returned, OR the row is still `pending` and `charge.refund.updated`
        // (processRefundUpdated → finalizeSucceededRefund) will finalise it
        // (A.11). Either way, this webhook branch is a no-op for a matched
        // row (idempotent) — post-A.12 it never flips the refund itself.
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
