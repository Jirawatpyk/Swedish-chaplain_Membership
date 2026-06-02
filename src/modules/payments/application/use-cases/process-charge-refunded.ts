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
  ClockPort,
  LoggerPort,
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
   * R3 M-2 rel (2026-04-28): added so tests can deterministically
   * control `completedAt` instead of relying on real wall-clock.
   * Aligns with the rest of the F5 use-case Deps shape.
   *
   * review-20260428-102639.md W5 closure — required (was optional).
   * Optional permitted Application-layer wall-clock leak; required
   * forces composition root + tests to thread a ClockPort, preserving
   * Constitution Principle III determinism.
   */
  readonly clock: ClockPort;
  /**
   * F5R3 SB-1 (2026-05-16) — optional logger for the
   * parent_status_recovery race-warn (concurrent writer flipped the
   * parent before this branch could). Optional so existing test
   * scaffolding without a logger still compiles; production
   * composition root threads the real pino logger.
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
        // H-1 (review 2026-04-27): if `issueRefund`'s Phase B
        // double-faulted, the in-app row stays `pending` and the
        // webhook is the natural reconciliation point — flip it to
        // `succeeded` here so the stale-pending sweep cron does not
        // later mark it `failed` for a refund Stripe already confirmed.
        // Optimistic-concurrency guard via `expectedCurrentStatus`:
        // a concurrent writer that already finalised the row to
        // `succeeded`/`failed` is left alone (idempotent webhook).
        if (existing && existing.status === 'pending') {
          // F5R1-E13 (partial fix) — sanity-check the DB refund amount
          // against the Stripe charge's TOTAL refunded amount. If the
          // DB row's amount exceeds the total Stripe-confirmed on this
          // charge, the DB and Stripe have diverged (e.g. admin edited
          // the refund via Stripe Dashboard, or partial-update bug).
          // Flag it loudly and SKIP the flip so an admin can reconcile.
          //
          // FULL per-refund amount invariance requires extending the
          // webhook-verifier projection to emit `refunds.data[i].amount`
          // per refund id (currently only `refundIds: string[]` + total
          // `amountSatang`). Tracked as R2 follow-up — see
          // `specs/009-online-payment/r10-carryover-from-f4.md` and
          // F5R1 review report.
          // F5R3v3 H-4 (2026-05-16) — skip mismatch comparison when
          // the verifier flagged the amount projection as failed
          // (input.amountSatang is the `?? 0n` default, not a real
          // value). Pre-fix every existing > 0 tripped the mismatch
          // branch → audit storm on a single fuzzed event. Sweep
          // cron reconciles the actual amount out of band.
          if (
            !input.amountProjectionFailed &&
            existing.amountSatang > input.amountSatang
          ) {
            // F5R2-SF-6 — dedicated `refund_amount_mismatch_detected`
            // event type (migration 0151) replaces the F5R1-E13
            // partial-fix that bucketed amount-mismatches under the
            // generic `out_of_band_refund_detected`. Operator
            // dashboards filtering for genuine OOB refunds (admin-via-
            // Stripe-Dashboard) now get a clean signal; the divergence
            // class has its own SRE alert pivot.
            await deps.audit.emit(tx, {
              tenantId: input.tenantId,
              requestId: input.requestId,
              eventType: 'refund_amount_mismatch_detected',
              actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
              summary: `Refund amount mismatch: DB row ${existing.id} amount ${existing.amountSatang} satang exceeds Stripe charge total refunded ${input.amountSatang} satang — admin must reconcile`,
              payload: {
                refund_id: existing.id,
                // existing.paymentId is the FK on the refund row to
                // its parent payment — the typed audit payload uses
                // string (not branded) since this is downstream of
                // the Domain boundary.
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
          await deps.refundsRepo.updateStatus(tx, {
            refundId: existing.id,
            tenantId: input.tenantId,
            nextStatus: 'succeeded',
            processorRefundId: refundId,
            completedAt: new Date(deps.clock.nowMs()),
            expectedCurrentStatus: 'pending',
          });
          // F5R3 SB-1 (2026-05-16) — flip the parent Payment.status too.
          // The original webhook-recovery path only updated the refund row
          // and left Payment.status drifted (still 'succeeded' even though
          // a refund was now succeeded). issueRefund's Phase B happy-path
          // updates BOTH atomically (issue-refund.ts:475-480) — a
          // double-fault that drops Phase B and lands here MUST mirror
          // the same parent-payment update or SC-013 ("succeeded payment
          // maps cleanly to invoice-paid/refunded states") silently
          // breaks. Read the new succeededSum + payment row, derive
          // next status, update with `expectedCurrentStatus` race-guard.
          // Acquire the payment-row FOR UPDATE lock BEFORE the refunds
          // aggregate read — getRefundContextForUpdate is explicitly designed
          // to run "inside the payment-row FOR UPDATE lock window"
          // (drizzle-refunds-repo.ts § design), and the canonical sibling
          // issue-refund.ts:278/292 locks first. Reading the succeededSum
          // before the lock left a READ COMMITTED window where a concurrent
          // refund could change the sum, deriving a stale 'refunded' vs
          // 'partially_refunded' status (the expectedCurrentStatus guard below
          // only protects the row write, not a status derived from a stale sum).
          const parent = await deps.paymentsRepo.lockForUpdate(
            tx,
            existing.paymentId,
            input.tenantId,
          );
          const ctx = await deps.refundsRepo.getRefundContextForUpdate(
            tx,
            input.tenantId,
            existing.paymentId,
          );
          let parentRecoveredTo: 'partially_refunded' | 'refunded' | null = null;
          if (
            parent != null &&
            (parent.status === 'succeeded' ||
              parent.status === 'partially_refunded')
          ) {
            const isFullyRefunded =
              ctx.succeededSumSatang >= parent.amountSatang;
            const nextPaymentStatus: 'partially_refunded' | 'refunded' =
              isFullyRefunded ? 'refunded' : 'partially_refunded';
            if (parent.status !== nextPaymentStatus) {
              const updated = await deps.paymentsRepo.updateStatus(tx, {
                paymentId: existing.paymentId,
                tenantId: input.tenantId,
                nextStatus: nextPaymentStatus,
                expectedCurrentStatus: parent.status,
                completedAt: new Date(deps.clock.nowMs()),
              });
              if (updated !== null) {
                parentRecoveredTo = nextPaymentStatus;
              } else {
                // expectedCurrentStatus race — concurrent writer flipped
                // the parent before we could; refund row is fine, parent
                // status was set by someone else. Silent no-op (idempotent).
                deps.logger?.warn(
                  'process_charge_refunded.parent_status_recovery_race',
                  {
                    tenantId: input.tenantId,
                    paymentId: existing.paymentId,
                    refundId: existing.id,
                    expectedStatus: parent.status,
                    attemptedNextStatus: nextPaymentStatus,
                  },
                );
              }
            }
          }
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'refund_succeeded',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Webhook-driven recovery: pending refund ${existing.id} flipped to succeeded after charge.refunded delivery (Phase B catch-up)`,
            payload: {
              path: 'webhook_recovery',
              refund_id: existing.id,
              processor_refund_id: refundId,
              processor_charge_id: input.chargeId,
              recovery_path: 'webhook_charge_refunded',
              parent_payment_status_recovered_to: parentRecoveredTo,
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
