/**
 * F8 Phase 5 Wave B · T138 — `reconcilePendingReactivations`.
 *
 * Daily cron walking cycles in `pending_admin_reactivation` to:
 *
 *   1. Emit `_reminder_t-7` audit at 23 days since `entered_pending_at`
 *   2. Emit `_reminder_t-3` audit at 27 days
 *   3. Emit `_reminder_t-1` audit at 29 days
 *   4. Auto-timeout at >= 30 days: LAPSE the cycle (→ `lapsed`,
 *      closed_reason='pending_reactivation_timed_out') + refund via F5 +
 *      emit `_timed_out` audit (actor=cron, null userId). NOTE: timeout
 *      lands in `lapsed` (passive expiry — stays in the re-engagement
 *      funnel), NOT `cancelled` (the explicit admin-reject terminal).
 *      See the terminal-state divergence note in cycle-status.ts
 *      (do-NOT-converge reporting invariant).
 *
 * The reminder-ladder audits (1-3) are forensic-only this wave — the
 * actual reminder-email send is the dispatcher cron's job (a follow-on
 * wave that subscribes to these audit rows + materialises a queue).
 * The audit row is the source of truth for "we noticed the cycle is
 * approaching timeout".
 *
 * Concurrency: per-cycle advisory lock acquired inside the auto-timeout
 * tx. Cron runs daily so contention is unlikely; lock prevents the
 * timeout transition from racing a concurrent admin approval (T136)
 * or rejection (T137).
 *
 * Refund handling on timeout: re-uses the same F5RefundBridge port as
 * T137. If F5 fails, we leave the cycle in pending + log a warning;
 * tomorrow's cron run retries. The 30-day boundary is a soft target —
 * a few days of refund-retry is preferable to leaving the member with
 * an orphaned charge.
 *
 * RBAC: cron-only (`actorRole='cron'`, `actorUserId=null`). Route
 * handler validates Bearer `CRON_SECRET` before invoking.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { asUserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { asInvoiceId, asCreditNoteId } from '@/modules/invoicing';
import { parseInput } from './_lib/parse-input';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { F5RefundBridge } from '../ports/f5-refund-bridge';
import type {
  CycleId,
  RenewalCycle,
} from '../../domain/renewal-cycle';
import { asTaskId } from '../../domain/renewal-escalation-task';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';
import type {
  ReminderAuditQueryPort,
  ReminderLadderAuditType,
} from '../ports/reminder-audit-query-repo';

export const reconcilePendingReactivationsInputSchema = z.object({
  tenantId: z.string().min(1),
  /** Injected clock for deterministic tests. */
  now: z.date(),
  /**
   * Optional cap on how many cycles to process per cron run (cost
   * control + tail-latency). Defaults to 1000 — the typical chamber
   * has <100 lapsed members, so a single run handles everything.
   */
  pageSize: z.number().int().min(1).max(5000).optional(),
  correlationId: z.string().min(1),
});

export type ReconcilePendingReactivationsInput = z.infer<
  typeof reconcilePendingReactivationsInputSchema
>;

export interface ReconcilePendingReactivationsOutput {
  readonly cyclesProcessed: number;
  /** Successfully emitted T-7 reminder audit rows in this run. */
  readonly remindersT7: number;
  /** Successfully emitted T-3 reminder audit rows in this run. */
  readonly remindersT3: number;
  /** Successfully emitted T-1 reminder audit rows in this run. */
  readonly remindersT1: number;
  readonly timedOut: number;
  /** Auto-timeouts where the F5 refund failed; cron will retry tomorrow. */
  readonly timeoutRefundFailures: number;
  /**
   * F8-RP (2026-07-11): auto-timeouts where the F5 refund was submitted but
   * is settling ASYNCHRONOUSLY (Stripe `pending`/`requires_action`, or a
   * prior refund already in-flight → `refund_in_progress`). The cycle stays
   * `pending_admin_reactivation` (NO transition) and self-heals on a later
   * cron pass once the `charge.refund.updated` webhook (A.11) / sweep (A.14)
   * settles the refund (the bridge then returns `no_payment_found` → normal
   * lapse). NOT counted in `timeoutRefundFailures` (nothing failed) and NOT
   * in `timedOut` (no lapse written). INFORMATIONAL — surfaced via
   * `renewalsMetrics.timeoutRefundPending`, never pages. Before F8-RP this
   * case was mislabelled as a refund failure.
   */
  readonly timeoutRefundPending: number;
  /**
   * MONEY-SAFETY (063 audit): timed-out cycles SKIPPED because the
   * validate-under-lock re-read found the cycle was no longer
   * `pending_admin_reactivation` — a concurrent admin approve (→ member
   * kept, no refund) or reject (→ refund already issued) won the race.
   * NO refund + NO transition happened. Distinct from `timedOut`
   * (success) and `timeoutRefundFailures` (Stripe failed). Surfaced so
   * SREs can see admin-vs-cron contention on the lapsed pipeline. Mirrors
   * the `transitionRaceSkipped` counter in `lapseCyclesOnGraceExpiry`.
   */
  readonly timeoutAdminRaceSkipped: number;
  /**
   * MONEY-SAFETY (063 xhigh review): timed-out cycles where the cron
   * DID issue the refund (the Step-1 validate-under-lock re-read found
   * the cycle still `pending_admin_reactivation`) but a concurrent admin
   * approve/reject — OR an optimistic-lock transition conflict — won the
   * *Step-3* window (between the refund and tx2's lock). The tx2 re-read
   * observed a non-pending status (or `transitionStatus` raised
   * `CycleTransitionConflictError`/`CycleNotFoundError`), so the cron did
   * NOT write the lapse transition. Net effect: the member ended up
   * `completed` (admin approved) but got their money back (cron already
   * refunded) — the ACCEPTED residual per #6, but a MONEY window SRE must
   * see. Distinct from `timeoutAdminRaceSkipped` (Step-1: admin won BEFORE
   * the refund, NO money moved) and `timedOut` (clean cancel+refund). The
   * OLD code silently folded this into `timedOut` via a fall-through
   * `return;`. Sustained non-zero alerts via
   * `renewalsMetrics.timeoutRefundOrphaned`.
   */
  readonly timeoutRefundOrphaned: number;
  /**
   * MONEY-SAFETY (063 xhigh review): timed-out cycles where the cron
   * issued the refund successfully but the tx2 transition/audit-emit
   * THREW a NON-conflict error (DB blip / RLS regression mid-tx). The
   * refund money is durable; the cycle stays `pending_admin_reactivation`
   * and the NEXT cron run re-enters `processTimeout`, where the F5 bridge
   * (`computeRemainingRefundable` returns null once the prior refund
   * settled) short-circuits without a second Stripe call and the
   * transition completes — i.e. the cron SELF-HEALS. The OLD code returned
   * `'refund_failed'` here, inflating `timeoutRefundFailures` and
   * mislabelling a SUCCEEDED refund as a refund failure. Distinct counter
   * so the "refund OK, transition failed, will self-heal" case is not
   * confused with a real Stripe failure. Alerts via
   * `renewalsMetrics.timeoutTransitionFailedPostRefund`.
   */
  readonly timeoutTransitionFailedPostRefund: number;
  /**
   * 063 follow-up classification fix: timed-out cycles where the tx2
   * transition/audit-emit threw a NON-conflict error (DB blip mid-tx) BUT
   * no refund had been issued (`refundIssued=false`) — the cycle had no
   * linked invoice (Step 2 skipped) OR the F5 bridge returned
   * `no_payment_found`. NO money is at stake; the cycle stays
   * `pending_admin_reactivation` and the next cron run self-heals (same as
   * the post-refund variant, minus the money). The prior 063 fix folded
   * this into `transitionFailedPostRefund`, which PAGES on-call after
   * 15 min — so a no-money DB blip falsely paged. Split out into this
   * INFORMATIONAL counter (mirrors `timeoutAdminRaceSkipped`) so the paging
   * metric stays reserved for real refunded-money-stuck-on-pending residuals.
   * Alerts via `renewalsMetrics.timeoutTransitionFailedNoRefund` (non-paging).
   */
  readonly timeoutTransitionFailedNoRefund: number;
  /**
   * Round 2 review-fix (I-6): reminder-rung audit emits that THREW
   * (DB connection blip / RLS regression / unique-constraint conflict).
   * Round 1 silently swallowed these into a `logger.warn` — a
   * misconfigured RLS could drop every reminder for weeks before
   * a member-support ticket surfaced the regression. The cron's
   * success counters (`remindersT7/T3/T1`) only bump on emit-success;
   * this counter tracks the failures (parity with `timeoutRefundFailures`).
   * Sustained non-zero rate alerts via
   * `renewalsMetrics.reminderAuditEmitFailures`.
   */
  readonly remindersFailed: number;
  /**
   * F8-RP follow-up (2026-07-12) — async reject-with-refund SETTLEMENT
   * counters. Cycles carrying the reject-refund marker
   * (`rejectRefundInitiatedAt !== null`) are reconciled EVERY cron pass,
   * regardless of `daysPending` and BEFORE the timeout/reminder branches —
   * their terminal must mirror the SYNC reject path (→ `cancelled`), never the
   * timeout (→ `lapsed`). Five terminal outcomes (parity with the timeout
   * counters):
   *
   *   - `asyncRejectSettledCancelled` — the marked refund SETTLED succeeded;
   *     the cycle converged → `cancelled`/`admin_rejected_with_refund`
   *     (byte-identical to the sync path: same closed_reason, the `_rejected`
   *     audit carrying the settled refund's credit-note id + the rejecting
   *     admin as actor, and the `post_refund_review` escalation task).
   *   - `asyncRejectRefundStillPending` — the marked refund is still settling;
   *     the cron leaves the cycle marked + pending for a later pass.
   *   - `asyncRejectRefundFailed` — the marked refund settled FAILED/canceled;
   *     the async refund never returned the money, so the cron CLEARS the
   *     marker (reverting to an ordinary pending cycle the admin re-handles)
   *     and fires an ALERTING metric. NEVER silently → cancelled / lapsed.
   *   - `asyncRejectLookupFailed` — the F5 settlement lookup failed (repo
   *     unavailable) or the refund id was not found; transient — the cycle
   *     stays marked + pending and the next cron pass retries.
   *   - `asyncRejectAdminRaceSkipped` — the tx-bound re-read under the lock
   *     found the cycle no longer `pending_admin_reactivation` (a concurrent
   *     admin approve/reject won between list + lock), or the transition lost
   *     the optimistic-lock race. Money residual surfaced (the refund may have
   *     settled against a now-non-pending cycle); NOT counted as settled.
   *   - `asyncRejectSettleFailed` — F8-RP-2 review fix (resilience): a
   *     NON-conflict error (DB blip / RLS regression mid-tx) threw from EITHER
   *     the succeeded-branch settle tx (transition + audit + escalation-task
   *     insert) OR the settled-`failed`-branch marker-clear tx (Finding 1). The
   *     tx rolled back — NO partial write landed — and the cycle stays
   *     marked+pending for the next cron pass to retry. Distinct from
   *     `asyncRejectAdminRaceSkipped` (a clean no-op race, not an error) and
   *     from `asyncRejectRefundFailed` (the F5 refund itself failed — this
   *     counter fires when the F5 refund SUCCEEDED but our own settle-write
   *     blipped). Mirrors the timeout branch's
   *     `timeoutTransitionFailedPostRefund` self-heal discipline. Per-cycle
   *     isolation (this counter existing at all) prevents one poison marked
   *     cycle from 500'ing the whole cron pass — parity with `processTimeout`.
   */
  readonly asyncRejectSettledCancelled: number;
  readonly asyncRejectRefundStillPending: number;
  readonly asyncRejectRefundFailed: number;
  readonly asyncRejectLookupFailed: number;
  readonly asyncRejectAdminRaceSkipped: number;
  readonly asyncRejectSettleFailed: number;
  /**
   * H1 reliability fix — loop-level per-cycle backstop. Counts cycles whose
   * processing threw an UNCLASSIFIED error that ESCAPED its per-cycle branch's
   * own error handling. Each per-cycle branch already classifies its KNOWN
   * failure modes and RETURNS a typed outcome/counter (settle_failed,
   * refund_failed, admin_race_skipped, transition_failed_*, …) — those are
   * returned, never thrown, so they never reach this backstop. This counter is
   * ONLY for a genuine escaped throw: e.g. `processTimeout`'s Step-1
   * validate-under-lock re-read (`acquireCycleLockInTx` + `findByIdInTx`) opens
   * an UNGUARDED `runInTenant`; a persistent NON-conflict throw there (DB blip /
   * RLS regression / poison row) escapes `processTimeout` and, without the
   * per-cycle try/catch, propagates through the caller for-loop and 500s the
   * WHOLE reconcile pass — blocking every OTHER marked/timeout/reminder cycle
   * for the tenant (a self-DoS; money-safe since read-only/rolled-back, but
   * availability-unsafe). The backstop isolates ANY such throw to its one cycle:
   * ERROR log (PCI-safe ids + error constructor name — never `error.message`) +
   * this distinct counter + `renewalsMetrics.cycleProcessingError` + `continue`.
   * DISTINCT + alertable (never silently swallowed): a sustained non-zero rate
   * means a per-cycle branch is chronically throwing an unhandled error and
   * warrants investigation (the escaped throw is a latent unguarded path, not a
   * classified outcome).
   */
  readonly cycleProcessingErrors: number;
}

export type ReconcilePendingReactivationsError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

/**
 * Subset of `RenewalsDeps` used by this cron use-case.
 *
 * T138 catch-up review-fix: `reminderAuditQuery` lets the cron detect
 * already-emitted reminders so a missed cron day (cron skip) doesn't
 * silently drop a reminder rung. The previous equality-only check
 * (`daysPending === REMINDER_LADDER threshold`) is now combined with
 * "no audit row of this type exists for this cycle" — see
 * `decideRemindersToFire` for the full rule.
 */
export interface ReconcilePendingReactivationsDeps
  extends Pick<
    RenewalsDeps,
    // F8-RP follow-up: `escalationTaskRepo` added so the async reject-with-
    // refund SETTLE branch inserts the same `post_refund_review` task the
    // SYNC reject path emits (byte-identical parity). `makeRenewalsDeps`
    // already provides it — the cron route wiring is unchanged.
    'tenant' | 'cyclesRepo' | 'auditEmitter' | 'escalationTaskRepo'
  > {
  readonly f5RefundBridge: F5RefundBridge;
  readonly reminderAuditQuery: ReminderAuditQueryPort;
}

/**
 * The pending-cycle auto-timeout boundary. Cycles whose
 * `daysPending >= PENDING_TIMEOUT_DAYS` flow through `processTimeout`
 * (cancel + F5 refund) instead of the reminder ladder. Round 4
 * review-fix (R4-S4) / Round 5 staff-review (R005) **invariant**: every
 * `REMINDER_LADDER[*].threshold` MUST be strictly less than this value,
 * otherwise that rung is silently consumed by the timeout branch before
 * the reminder loop fires. Enforced by a dedicated unit test
 * (`reminder-ladder-invariants.test.ts`) that imports both constants
 * and asserts the bound — chosen over a module-load throw so test
 * imports of the module are side-effect-free (a future test that
 * mocks something else in this file inherits no surprise throws).
 */
export const PENDING_TIMEOUT_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/**
 * F8-RP follow-up — the finance follow-up task type + due window for the async
 * reject-with-refund SETTLE branch. Mirrors the SYNC reject path
 * (`admin-reject-reactivation.ts`) EXACTLY so async + sync land byte-identical:
 * idempotent on `(tenant, member, cycle, task_type) WHERE status='open'`.
 */
const POST_REFUND_REVIEW_TASK_TYPE = 'post_refund_review' as const;
const POST_REFUND_REVIEW_DUE_DAYS = 3;

/**
 * F8-RP follow-up — terminal outcome of `processMarkedRejectRefund` for one
 * marked cycle. Mirrors `ProcessTimeoutOutcome`'s independent-count discipline:
 *   - `settled_cancelled`   — refund settled → cycle converged to `cancelled`
 *     (sync-path exact terminal: closed_reason + `_rejected` audit w/ the
 *     settled CN id + the REPLAYED admin actor + the `post_refund_review` task).
 *   - `refund_pending`      — refund still settling; cron waits (no transition).
 *   - `refund_failed`       — refund settled failed/canceled → marker CLEARED,
 *     cycle reverts to ordinary pending (NEVER cancelled/lapsed); alerting.
 *   - `lookup_failed`       — F5 settlement lookup unavailable / refund id not
 *     found; cycle stays marked+pending, retry next pass (marker NOT cleared).
 *   - `admin_race_skipped`  — the tx re-read under the lock found the cycle no
 *     longer pending (concurrent admin approve/reject won), OR the transition
 *     lost the optimistic-lock race. No transition; money residual surfaced.
 *   - `settle_failed`       — F8-RP-2 review fix (resilience): a NON-conflict
 *     error (DB blip / RLS regression mid-tx) threw from EITHER of the two
 *     write-txs this function opens — the SUCCEEDED-branch settle tx (transition
 *     + `emitInTx` + the `post_refund_review` task insert + its audit) OR the
 *     settled-`failed`-branch marker-clear tx (Finding 1: `acquireCycleLockInTx`
 *     + `clearRejectRefundMarkerInTx`). `CycleTransitionConflictError`/
 *     `CycleNotFoundError` are handled above and never reach this outcome.
 *     Mirrors `ProcessTimeoutOutcome`'s
 *     `transition_failed_post_refund`/`transition_failed_no_refund`
 *     self-heal discipline: the tx rolled back (no partial write), the
 *     cycle stays marked+pending, and the NEXT cron pass retries the same
 *     settle from scratch. Before this fix the throw escaped
 *     `processMarkedRejectRefund` uncaught, propagated through the caller's
 *     for-loop (which has no try/catch either), and 500'd the ENTIRE
 *     reconcile pass — a single poison marked cycle could block every other
 *     marked/timeout/reminder cycle in the same tenant's run (self-DoS;
 *     money-safe, since the tx rolls back, but availability-unsafe).
 */
type ProcessMarkedRejectOutcome =
  | 'settled_cancelled'
  | 'refund_pending'
  | 'refund_failed'
  | 'lookup_failed'
  | 'admin_race_skipped'
  | 'settle_failed';

/**
 * Round 3 review-fix (R3-S6+S7): single source of truth for the
 * reminder ladder — threshold (days pending) + audit event type.
 * Used by both `decideRemindersToFire` (which rungs to emit?) and
 * the cron's per-rung counter map (how many landed?). Adding a new
 * rung (e.g. T-14) requires editing only this array; the
 * `Record<ReminderLadderAuditType, number>` counter forces a
 * compile error until the corresponding key is initialised, so
 * silent drift between threshold + type + counter is ruled out at
 * compile time. Order is chronological (earliest threshold first)
 * so the iteration in `decideRemindersToFire` produces audit rows
 * in chronological rung order.
 */
export const REMINDER_LADDER: ReadonlyArray<{
  readonly threshold: number;
  readonly type: ReminderLadderAuditType;
}> = [
  { threshold: 23, type: 'lapsed_member_admin_reactivation_reminder_t-7' }, // 30 - 7
  { threshold: 27, type: 'lapsed_member_admin_reactivation_reminder_t-3' }, // 30 - 3
  { threshold: 29, type: 'lapsed_member_admin_reactivation_reminder_t-1' }, // 30 - 1
];

export async function reconcilePendingReactivations(
  deps: ReconcilePendingReactivationsDeps,
  rawInput: ReconcilePendingReactivationsInput,
): Promise<
  Result<
    ReconcilePendingReactivationsOutput,
    ReconcilePendingReactivationsError
  >
> {
  // Round 2 review-fix (M2): adopt the shared `parseInput` helper
  // for consistency with block-/unblock-/opt-in/opt-out use-cases.
  // Same observable behaviour (first-issue-message + 'invalid input'
  // fallback), narrower surface for future evolution.
  const inputResult = parseInput(
    reconcilePendingReactivationsInputSchema,
    rawInput,
  );
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;
  const pageSize = input.pageSize ?? 1000;

  // Single page of pending cycles ordered by entered_pending_at ASC
  // (oldest first — those closest to the 30-day boundary).
  const page = await deps.cyclesRepo.list(input.tenantId, {
    statusFilter: ['pending_admin_reactivation'],
    pageSize,
    sort: 'expires_at_asc',
  });

  // Round 3 review-fix (R3-S7): Record-based counters keyed on the
  // canonical reminder-ladder audit type union. TS exhaustiveness
  // ensures that adding a new rung to `REMINDER_LADDER_AUDIT_TYPES`
  // (the const-array source of truth at `reminder-audit-query-repo.ts`)
  // creates a compile error here until the new key is initialised.
  const reminderCounters: Record<ReminderLadderAuditType, number> = {
    'lapsed_member_admin_reactivation_reminder_t-7': 0,
    'lapsed_member_admin_reactivation_reminder_t-3': 0,
    'lapsed_member_admin_reactivation_reminder_t-1': 0,
  };
  let remindersFailed = 0;
  let timedOut = 0;
  let timeoutRefundFailures = 0;
  let timeoutRefundPending = 0;
  let timeoutAdminRaceSkipped = 0;
  let timeoutRefundOrphaned = 0;
  let timeoutTransitionFailedPostRefund = 0;
  let timeoutTransitionFailedNoRefund = 0;
  // F8-RP follow-up async reject-with-refund settlement counters.
  let asyncRejectSettledCancelled = 0;
  let asyncRejectRefundStillPending = 0;
  let asyncRejectRefundFailed = 0;
  let asyncRejectLookupFailed = 0;
  let asyncRejectAdminRaceSkipped = 0;
  let asyncRejectSettleFailed = 0;
  // H1 reliability fix — loop-level per-cycle backstop counter.
  let cycleProcessingErrors = 0;

  // H1 reliability fix — the per-cycle processing is extracted into this named
  // unit so the caller loop can wrap EACH cycle in a TIGHT try/catch backstop.
  // Each branch below (marked / timeout / reminder) already classifies its KNOWN
  // failure modes and RETURNS a typed outcome (settle_failed, refund_failed,
  // admin_race_skipped, transition_failed_*, …); those never throw, so the
  // backstop below can NEVER mask or re-label a classified outcome. The backstop
  // exists SOLELY to isolate an UNCLASSIFIED throw that escapes a branch — the
  // canonical case being `processTimeout`'s Step-1 validate-under-lock re-read,
  // which opens an UNGUARDED `runInTenant` (`acquireCycleLockInTx` +
  // `findByIdInTx`); a persistent NON-conflict throw there would otherwise
  // propagate out of the loop and 500 the WHOLE pass, blocking every OTHER cycle
  // for the tenant (self-DoS). Closing it at the loop level (rather than
  // wrapping only Step-1) also covers any FUTURE unguarded per-cycle
  // `runInTenant`. Mutates the run-scoped counters above via closure (same
  // pattern the inline loop used); the per-cycle skips that were `continue`
  // become `return` (identical control flow — the loop advances to the next
  // cycle either way).
  async function processCycle(cycle: RenewalCycle): Promise<void> {
    // F8-RP follow-up: a cycle carrying the async reject-with-refund marker is
    // reconciled to its intended `cancelled` terminal EVERY pass, regardless
    // of `daysPending` and BEFORE the timeout/reminder branches — an admin
    // reject must never fall into the timeout → `lapsed` path. `continue`
    // guarantees a marked cycle never reaches `processTimeout` (which would
    // otherwise issue a redundant refund + mislabel the outcome as a timeout).
    if (
      cycle.status === 'pending_admin_reactivation' &&
      cycle.rejectRefundInitiatedAt !== null
    ) {
      const outcome = await processMarkedRejectRefund(
        deps,
        cycle,
        input.correlationId,
        input.now,
      );
      switch (outcome) {
        case 'settled_cancelled':
          asyncRejectSettledCancelled += 1;
          renewalsMetrics.asyncRejectRefundReconciled(
            cycle.tenantId,
            'settled_cancelled',
          );
          break;
        case 'refund_pending':
          asyncRejectRefundStillPending += 1;
          renewalsMetrics.asyncRejectRefundReconciled(
            cycle.tenantId,
            'still_pending',
          );
          break;
        case 'refund_failed':
          asyncRejectRefundFailed += 1;
          renewalsMetrics.asyncRejectRefundReconciled(
            cycle.tenantId,
            'refund_failed',
          );
          break;
        case 'lookup_failed':
          asyncRejectLookupFailed += 1;
          renewalsMetrics.asyncRejectRefundReconciled(
            cycle.tenantId,
            'lookup_failed',
          );
          break;
        case 'admin_race_skipped':
          asyncRejectAdminRaceSkipped += 1;
          renewalsMetrics.asyncRejectRefundReconciled(
            cycle.tenantId,
            'admin_race_skipped',
          );
          break;
        case 'settle_failed':
          // F8-RP-2 review fix: the settle tx threw a non-conflict error
          // (DB blip / RLS regression mid-tx) — caught INSIDE
          // `processMarkedRejectRefund` so it never reaches this loop as an
          // exception. The tx rolled back (no partial write); the cycle
          // stays marked+pending and self-heals on the next cron pass.
          asyncRejectSettleFailed += 1;
          renewalsMetrics.asyncRejectRefundReconciled(
            cycle.tenantId,
            'settle_failed',
          );
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
      return; // H1: was `continue` — see processCycle extraction note
    }
    const daysPending = computeDaysPending(cycle, input.now);
    if (daysPending === null) return; // missing entered_pending_at — defensive (H1: was `continue`)
    if (daysPending >= PENDING_TIMEOUT_DAYS) {
      const outcome = await processTimeout(
        deps,
        cycle,
        input.correlationId,
        input.now,
      );
      switch (outcome) {
        case 'timed_out':
          timedOut += 1;
          break;
        case 'refund_failed':
          timeoutRefundFailures += 1;
          break;
        case 'refund_pending':
          // F8-RP: the F5 refund is settling asynchronously (Stripe
          // pending/requires_action, or a prior refund already in-flight).
          // NOT a failure and NOT a lapse — the cycle stays pending and
          // self-heals next run. Surfaced via its own informational counter.
          timeoutRefundPending += 1;
          renewalsMetrics.timeoutRefundPending(cycle.tenantId);
          break;
        case 'admin_race_skipped':
          timeoutAdminRaceSkipped += 1;
          renewalsMetrics.timeoutAdminRaceSkipped(cycle.tenantId);
          break;
        case 'post_refund_admin_race':
          // 063: refund WAS issued, then admin/conflict won the tx2
          // window. NOT a timeout (no transition), NOT a refund failure
          // (refund succeeded). The accepted money residual per #6 —
          // surfaced via its own counter so SRE sees the window.
          timeoutRefundOrphaned += 1;
          renewalsMetrics.timeoutRefundOrphaned(cycle.tenantId);
          break;
        case 'transition_failed_post_refund':
          // 063: refund succeeded, tx2 transition threw a non-conflict
          // error. NOT a refund failure — the refund is durable and the
          // next cron run self-heals (F5 short-circuits the second
          // refund). Distinct counter so it is not confused with a real
          // Stripe failure (`timeoutRefundFailures`). PAGES on-call.
          timeoutTransitionFailedPostRefund += 1;
          renewalsMetrics.timeoutTransitionFailedPostRefund(cycle.tenantId);
          break;
        case 'transition_failed_no_refund':
          // 063 follow-up: tx2 transition threw a non-conflict error but NO
          // refund had been issued (no linked invoice OR no_payment_found).
          // No money at stake; the cycle stays pending + self-heals next
          // run. INFORMATIONAL counter — NOT the paging post-refund metric,
          // so a no-money DB blip does not falsely page on-call.
          timeoutTransitionFailedNoRefund += 1;
          renewalsMetrics.timeoutTransitionFailedNoRefund(cycle.tenantId);
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
      return; // H1: was `continue` — see processCycle extraction note
    }
    // T138 catch-up review-fix: instead of equality-only firing
    // (which silently drops a reminder when the cron skips that exact
    // day), look up which reminder-ladder audit rows already exist for
    // the cycle and emit only the rungs whose threshold has been
    // crossed AND whose audit row is missing. This makes the daily
    // cron self-healing — a day-25 invocation that finds no T-7 audit
    // for a cycle at daysPending=25 still fires the reminder.
    const alreadyEmitted = await deps.reminderAuditQuery
      .findReminderAuditsForCycle(cycle.tenantId, cycle.cycleId)
      .catch((e: unknown) => {
        // Round 2 review fix (I-1): read-only audit query failure is
        // non-fatal — fall back to "fire-all-crossed-rungs" so the cron
        // does NOT block on a stale audit-log connection. Trade-off: a
        // transient outage WILL cause duplicate reminder audit rows
        // (e.g. day-28 cycle re-fires T-7 even though it was emitted
        // on day-23 already). We accept the duplicate-audit risk over
        // the silently-dropped-reminder risk per Constitution
        // Principle V (Reliability): the dispatcher cron is idempotent
        // on send (Resend dedupe) so duplicate emails are bounded.
        // Counter `renewalsMetrics.reminderAuditQueryFailures` lets SREs
        // see this on a dashboard before it spirals.
        renewalsMetrics.reminderAuditQueryFailures.add(1, {
          tenant_id: cycle.tenantId,
        });
        logger.error(
          {
            errorId: 'F8.RECONCILE.AUDIT_QUERY_FAILED',
            tenantId: cycle.tenantId,
            cycleId: cycle.cycleId,
            err: e instanceof Error ? e.message : String(e),
          },
          '[reconcile-pending-reactivations] reminderAuditQuery failed — falling back to fire-all-crossed-rungs',
        );
        return new Set<ReminderLadderAuditType>();
      });
    const toFire = decideRemindersToFire(daysPending, alreadyEmitted);
    // Round 2 review-fix (I-6): success counters only bump on emit
    // success — Round 1 incremented unconditionally even when the emit
    // threw. `remindersFailed` collects the misses for observability.
    // Iteration order matches `decideRemindersToFire` insertion order
    // (T-7 → T-3 → T-1) so audit rows arrive in chronological rung order.
    for (const type of toFire) {
      const ok = await emitReminderAudit(deps, cycle, type, input.correlationId);
      if (!ok) {
        remindersFailed += 1;
        continue;
      }
      reminderCounters[type] += 1;
    }
  }

  // H1 reliability fix — TOP-LEVEL per-cycle backstop. `processCycle` handles a
  // single cycle and reports its CLASSIFIED outcome via the run-scoped counters;
  // any UNCLASSIFIED throw that escapes it (e.g. the timeout branch's Step-1
  // unguarded re-read) is isolated HERE — never allowed to abort the pass and
  // block every other cycle. Made VISIBLE (not silently swallowed) via the
  // distinct, alertable `cycleProcessingErrors` counter +
  // `renewalsMetrics.cycleProcessingError` + an ERROR log (PCI-safe ids + the
  // error CONSTRUCTOR NAME only — NEVER `error.message`, which on the
  // payment-adjacent refund path could carry processor detail) — then the loop
  // continues to the next cycle. Classified per-branch outcomes are RETURNED,
  // not thrown, so this never masks or re-labels one.
  for (const cycle of page.items) {
    try {
      await processCycle(cycle);
    } catch (e) {
      cycleProcessingErrors += 1;
      renewalsMetrics.cycleProcessingError(cycle.tenantId);
      logger.error(
        {
          errorId: 'F8.RECONCILE.CYCLE_PROCESSING_ERROR',
          cycleId: cycle.cycleId,
          tenantId: cycle.tenantId,
          errorName: e instanceof Error ? e.constructor.name : typeof e,
        },
        '[reconcile-pending-reactivations] unclassified per-cycle throw escaped branch handling — isolated to this cycle (counted + alerting); reconcile pass continues',
      );
      continue;
    }
  }

  return ok({
    cyclesProcessed: page.items.length,
    remindersT7: reminderCounters['lapsed_member_admin_reactivation_reminder_t-7'],
    remindersT3: reminderCounters['lapsed_member_admin_reactivation_reminder_t-3'],
    remindersT1: reminderCounters['lapsed_member_admin_reactivation_reminder_t-1'],
    remindersFailed,
    timedOut,
    timeoutRefundFailures,
    timeoutRefundPending,
    timeoutAdminRaceSkipped,
    timeoutRefundOrphaned,
    timeoutTransitionFailedPostRefund,
    timeoutTransitionFailedNoRefund,
    asyncRejectSettledCancelled,
    asyncRejectRefundStillPending,
    asyncRejectRefundFailed,
    asyncRejectLookupFailed,
    asyncRejectAdminRaceSkipped,
    asyncRejectSettleFailed,
    cycleProcessingErrors,
  });
}

/**
 * Outcome of `processTimeout` for one timed-out cycle. Six terminal
 * states — counted independently by the caller (parity with
 * `lapseCyclesOnGraceExpiry`'s `ProcessOneOutcome`):
 *   - `'timed_out'`        — refund issued (or no payment) + cycle lapsed.
 *   - `'refund_failed'`    — F5/Stripe refund FAILED (no refund issued);
 *     cron retries tomorrow.
 *   - `'admin_race_skipped'` — admin approve/reject — or an optimistic-lock
 *     `CycleTransitionConflictError`/`CycleNotFoundError` — won a lock race
 *     while NO money had moved. Covers both the *Step-1* window (admin won
 *     BEFORE the refund — the cron never reached F5) AND the *Step-3* window
 *     on a NO-MONEY cycle (no linked invoice OR `no_payment_found` →
 *     `refundIssued=false`): nothing to reconcile, so the no-money Step-3
 *     race collapses to the same clean no-op as Step-1. NO refund, NO
 *     transition.
 *   - `'post_refund_admin_race'` — 063 xhigh fix: the cron DID issue the
 *     refund (`refundIssued=true` — Step-1 re-read saw pending AND the F5
 *     bridge returned `refunded`) but an admin approve/reject — or an
 *     optimistic-lock `CycleTransitionConflictError`/`CycleNotFoundError`
 *     — won the *Step-3* window (between the refund and tx2's lock). The
 *     tx2 re-read observed non-pending (or the transition raised a
 *     conflict), so the cron did NOT write the lapse. Money WAS refunded
 *     against a now-non-pending cycle — the accepted residual per #6,
 *     surfaced (not hidden as `'timed_out'`) so the money window is
 *     observable. **Precondition (063 follow-up): only fires when
 *     `refundIssued`** — a no-money Step-3 race maps to `'admin_race_skipped'`
 *     instead. Self-heals: the cycle is already terminal (admin won) so
 *     no further cron action is needed; the F5 credit-note is durable.
 *   - `'transition_failed_post_refund'` — 063 xhigh fix: **`refundIssued`**
 *     succeeded but the tx2 transition/audit-emit threw a NON-conflict
 *     error (DB blip mid-tx). The cycle stays pending; the NEXT cron run
 *     re-enters `processTimeout`, F5 short-circuits the second refund
 *     (prior refund already settled), and the transition completes — i.e.
 *     the cron SELF-HEALS. Classified distinctly from `'refund_failed'`
 *     because the refund SUCCEEDED (the money is durable). **Precondition
 *     (063 follow-up): only fires when `refundIssued`** — PAGES on-call,
 *     so a no-money tx2 blip must NOT land here (see below).
 *   - `'transition_failed_no_refund'` — 063 follow-up: the tx2 transition/
 *     audit-emit threw a NON-conflict error but `refundIssued=false` (no
 *     linked invoice OR `no_payment_found`). Same self-heal as the
 *     post-refund variant, minus the money — so it is classified distinctly
 *     and routed to an INFORMATIONAL counter, NOT the paging post-refund
 *     metric. Prevents a no-money DB blip from falsely paging on-call.
 */
type ProcessTimeoutOutcome =
  | 'timed_out'
  | 'refund_failed'
  // F8-RP: the F5 refund was submitted but is settling ASYNCHRONOUSLY
  // (Stripe `pending`/`requires_action`, or a prior refund already in-flight
  // → `refund_in_progress`). The row stays `pending`; the cron leaves the
  // cycle in `pending_admin_reactivation` (NO transition) and self-heals on
  // a later pass once the webhook/sweep settles the refund. NOT a failure
  // (money did not fail to move) and NOT a lapse. Money-safe: the pending
  // row blocks a double refund. Classified distinctly from `refund_failed`
  // so an in-flight refund is not mislabelled as a Stripe failure.
  | 'refund_pending'
  | 'admin_race_skipped'
  | 'post_refund_admin_race'
  | 'transition_failed_post_refund'
  | 'transition_failed_no_refund';

/**
 * T138 catch-up review-fix: pure decision fn — given a cycle's
 * `daysPending` and the set of reminder-ladder audit rows already
 * emitted, returns the subset of reminder rungs the current cron run
 * MUST emit. The rule is "threshold crossed + not yet emitted":
 *
 *   - Day ≥ 23 + no T-7 audit → emit T-7
 *   - Day ≥ 27 + no T-3 audit → emit T-3
 *   - Day ≥ 29 + no T-1 audit → emit T-1
 *
 * Idempotency comes from the audit-existence guard, not the equality
 * day-match. Day 24 with NO T-7 row → still fires T-7 (catch-up after
 * a missed day 23 cron). Day 24 with a T-7 row already → no fire.
 *
 * Pure for testability — no side effects.
 */
export function decideRemindersToFire(
  daysPending: number,
  alreadyEmitted: ReadonlySet<ReminderLadderAuditType>,
): Set<ReminderLadderAuditType> {
  const out = new Set<ReminderLadderAuditType>();
  for (const { threshold, type } of REMINDER_LADDER) {
    if (daysPending >= threshold && !alreadyEmitted.has(type)) {
      out.add(type);
    }
  }
  return out;
}

function computeDaysPending(cycle: RenewalCycle, now: Date): number | null {
  if (cycle.status !== 'pending_admin_reactivation') return null;
  if (cycle.enteredPendingAt === null) return null;
  const entered = new Date(cycle.enteredPendingAt);
  const ms = now.getTime() - entered.getTime();
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * Round 2 review-fix (I-6): returns `true` on emit success, `false` on
 * throw. The cron caller increments the success counter
 * (`remindersT7/T3/T1`) only on `true` and `remindersFailed` on `false`,
 * giving SREs an accurate "what landed in audit_log" tally instead of
 * the Round 1 lie ("we sent 47 reminders" when 47 emits ALL threw).
 *
 * Throws are still NON-fatal for the cron (one bad cycle must not
 * abort the whole run), but they are now logged at `error` level
 * (was `warn`) with `errorId` for Sentry grouping + bumped via
 * `renewalsMetrics.reminderAuditEmitFailures` for dashboard alerts.
 */
async function emitReminderAudit(
  deps: ReconcilePendingReactivationsDeps,
  cycle: RenewalCycle,
  type:
    | 'lapsed_member_admin_reactivation_reminder_t-7'
    | 'lapsed_member_admin_reactivation_reminder_t-3'
    | 'lapsed_member_admin_reactivation_reminder_t-1',
  correlationId: string,
): Promise<boolean> {
  try {
    await deps.auditEmitter.emit(
      {
        type,
        payload: {
          cycle_id: cycle.cycleId,
          member_id: cycle.memberId,
        },
      },
      {
        tenantId: cycle.tenantId,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
      },
    );
    return true;
  } catch (e) {
    renewalsMetrics.reminderAuditEmitFailures.add(1, {
      tenant_id: cycle.tenantId,
      type,
    });
    logger.error(
      {
        errorId: 'F8.RECONCILE.REMINDER_EMIT_FAILED',
        tenantId: cycle.tenantId,
        cycleId: cycle.cycleId,
        type,
        err: e instanceof Error ? e.message : String(e),
      },
      '[reconcile-pending-reactivations] reminder audit emit failed — counted in remindersFailed; cron continues',
    );
    return false;
  }
}

/**
 * F8-RP follow-up — settle a MARKED (async reject-with-refund) cycle.
 *
 * Ordering mirrors `adminRejectReactivation` + `processTimeout`: the F5
 * settlement lookup runs OUTSIDE any tx (read-only F5 query), then the cancel
 * transition + audit + escalation task run in ONE tx under the per-cycle
 * advisory lock with a tx-bound re-read (TOCTOU). The SUCCEEDED terminal is
 * BYTE-IDENTICAL to the sync reject path — same closed_reason, the same
 * `_rejected` audit carrying the settled refund's credit-note id and the
 * REPLAYED rejecting admin as actor (NOT the cron), and the same
 * `post_refund_review` finance escalation task.
 */
async function processMarkedRejectRefund(
  deps: ReconcilePendingReactivationsDeps,
  cycle: RenewalCycle,
  correlationId: string,
  now: Date,
): Promise<ProcessMarkedRejectOutcome> {
  const cycleId = cycle.cycleId as CycleId;

  // Marker invariant (defensive): a marked cycle always has a linked invoice +
  // refund id + actor (the reject use-case records the marker only when
  // linkedInvoiceId !== null AND F5 supplied the refund id, stamping the actor
  // in the same write). If any is missing the row is inconsistent — treat as a
  // transient lookup failure so the marker persists for a later pass / manual
  // handling; NEVER silently cancel or lapse. The null-guard also narrows the
  // three fields to non-null for the audit actor + F5 lookup below.
  if (
    cycle.linkedInvoiceId === null ||
    cycle.rejectRefundId === null ||
    cycle.rejectActorUserId === null
  ) {
    logger.error(
      {
        cycleId,
        tenantId: cycle.tenantId,
        hasInvoice: cycle.linkedInvoiceId !== null,
        hasRefundId: cycle.rejectRefundId !== null,
        hasActor: cycle.rejectActorUserId !== null,
      },
      '[reconcile-pending-reactivations] marked reject-refund cycle missing invoice/refund-id/actor — leaving marked+pending for manual handling',
    );
    return 'lookup_failed';
  }
  const rejectActorUserId = cycle.rejectActorUserId;
  // Capture the resolved refund id (R1) as a stable const post-guard: the
  // FAILED-branch marker-clear guards on it (Finding 5) and passes it into a
  // `runInTenant` closure, where property narrowing on `cycle.rejectRefundId`
  // would NOT survive — a const keeps the non-null narrowing across the closure.
  const rejectRefundId = cycle.rejectRefundId;

  // Step 1 (read-only, outside tx): resolve the F5 refund settlement.
  const settlement = await deps.f5RefundBridge.getRefundOutcomeForInvoice({
    tenantId: asTenantId(cycle.tenantId),
    invoiceId: asInvoiceId(cycle.linkedInvoiceId),
    refundId: rejectRefundId,
  });

  if (settlement.status === 'lookup_failed' || settlement.status === 'not_found') {
    // Transient (repo unavailable) or the refund id was not found in the F5
    // activity. Leave the cycle marked + pending — the marker is NOT cleared,
    // so the next cron pass retries. Do NOT cancel/lapse on an unresolved read.
    logger.warn(
      {
        cycleId,
        tenantId: cycle.tenantId,
        lookupStatus: settlement.status,
      },
      '[reconcile-pending-reactivations] async reject-refund settlement unresolved — cycle stays marked+pending, retry next pass',
    );
    return 'lookup_failed';
  }

  if (settlement.status === 'pending') {
    // Still settling — wait for a later pass. No transition, marker intact.
    return 'refund_pending';
  }

  if (settlement.status === 'failed') {
    // The async refund settled FAILED/canceled — the money never returned. The
    // cycle MUST NOT converge to `cancelled` (which would imply the refund
    // completed) and MUST NOT lapse. Clear the marker (revert to an ordinary
    // pending cycle the admin re-handles via the pending queue — the SYNC
    // reject path's own refund-failure treatment: it returns `refund_failed`
    // and leaves the cycle pending). Fire an alerting outcome + a loud log.
    //
    // Finding 1 (F8-RP-2 review — per-cycle error isolation): wrap the
    // marker-clear tx in the SAME try/catch the succeeded branch uses. A
    // persistent NON-conflict throw from `acquireCycleLockInTx` /
    // `clearRejectRefundMarkerInTx` (DB blip / RLS regression) would otherwise
    // escape `processMarkedRejectRefund`, propagate through the caller's
    // unguarded for-loop, and 500 the ENTIRE reconcile pass (self-DoS) —
    // blocking every other marked/timeout/reminder cycle for the tenant. Isolate
    // it: `runInTenant` rolled the tx back (no partial write; the marker stays
    // intact), so the cycle is untouched and the NEXT cron pass re-resolves
    // settlement=failed and retries the clear. Classified `settle_failed`
    // (money-safe, self-heals) — parity with the succeeded branch's outer catch.
    let cleared: boolean;
    try {
      cleared = await runInTenant(deps.tenant, async (tx) => {
        await deps.cyclesRepo.acquireCycleLockInTx(tx, cycle.tenantId, cycleId);
        // Finding 5: guard the clear on the SAME refund id we resolved above
        // (R1). If a concurrent re-reject overwrote the marker with a fresh R2
        // in the read→clear window, the guarded UPDATE matches 0 rows (no-op)
        // rather than wiping R2's live marker — so R2's own settlement still
        // converges the cycle instead of being silently unmarked → lapsed.
        return deps.cyclesRepo.clearRejectRefundMarkerInTx(
          tx,
          cycle.tenantId,
          cycleId,
          rejectRefundId,
        );
      });
    } catch (e) {
      logger.error(
        {
          cycleId,
          tenantId: cycle.tenantId,
          refundId: rejectRefundId,
          err: e instanceof Error ? e.message : String(e),
        },
        '[reconcile-pending-reactivations] async reject-refund FAILED-branch marker-clear tx threw (non-conflict) — tx rolled back, cycle stays marked+pending; next cron pass retries',
      );
      return 'settle_failed';
    }
    logger.error(
      {
        cycleId,
        tenantId: cycle.tenantId,
        refundId: rejectRefundId,
        failureReasonCode: settlement.failureReasonCode,
        markerCleared: cleared,
      },
      '[reconcile-pending-reactivations] async reject-refund SETTLED FAILED — money not returned; marker cleared, cycle reverts to pending for admin re-handling (alerting)',
    );
    return 'refund_failed';
  }

  // settlement.status === 'succeeded' — converge → `cancelled`, byte-identical
  // to the SYNC reject path. Lock + tx-bound re-read (TOCTOU) then transition +
  // audit + escalation task, all atomic in one tx (Constitution Principle VIII).
  const creditNoteId = settlement.creditNoteId;
  const closedAt = now.toISOString();
  // F8-RP-2 review fix (resilience — per-cycle error isolation): mirror
  // `processTimeout`'s tx2 outer try/catch EXACTLY. `CycleTransitionConflictError`
  // / `CycleNotFoundError` are already caught INSIDE the tx (below) and return
  // `admin_race_skipped` — this outer catch exists solely to stop a NON-conflict
  // throw from `emitInTx`, `escalationTaskRepo.insertIfAbsent`, the 2nd `emitInTx`,
  // or any other unexpected DB blip mid-tx from escaping this function. Before this
  // fix, such a throw propagated through the caller's for-loop (which has no
  // try/catch of its own — same as `processTimeout`'s caller) and 500'd the ENTIRE
  // reconcile pass, so one poison marked cycle could block every other marked/
  // timeout/reminder cycle for the tenant. Money-safe either way (the tx rolls
  // back — no partial write lands), but NOT availability-safe without this guard.
  try {
    return await runInTenant(
      deps.tenant,
      async (tx): Promise<ProcessMarkedRejectOutcome> => {
        await deps.cyclesRepo.acquireCycleLockInTx(tx, cycle.tenantId, cycleId);
        const reread = await deps.cyclesRepo.findByIdInTx(
          tx,
          cycle.tenantId,
          cycleId,
        );
        if (
          !reread ||
          reread.status !== 'pending_admin_reactivation' ||
          reread.rejectRefundInitiatedAt === null
        ) {
          // A concurrent admin approve/reject (or a marker clear) won between
          // list + lock. The refund already settled against a now-non-pending
          // cycle — surface the money residual (do NOT write the cancel).
          logger.warn(
            {
              cycleId,
              tenantId: cycle.tenantId,
              observedStatus: reread?.status ?? 'not_found',
            },
            '[reconcile-pending-reactivations] async reject-refund settled but cycle no longer pending/marked at lock — admin race; skipping cancel transition',
          );
          return 'admin_race_skipped';
        }

        let updated: RenewalCycle;
        try {
          updated = await deps.cyclesRepo.transitionStatus(
            tx,
            cycle.tenantId,
            cycleId,
            {
              from: 'pending_admin_reactivation',
              to: 'cancelled',
              closedAt,
              closedReason: 'admin_rejected_with_refund',
            },
          );
        } catch (e) {
          if (
            e instanceof CycleTransitionConflictError ||
            e instanceof CycleNotFoundError
          ) {
            logger.warn(
              { cycleId, tenantId: cycle.tenantId, err: e.message },
              '[reconcile-pending-reactivations] async reject-refund cancel transition lost optimistic-lock race — admin/conflict won; skipping',
            );
            return 'admin_race_skipped';
          }
          throw e;
        }

        // `lapsed_member_admin_reactivation_rejected` audit — byte-identical to
        // the sync path: same payload (cycle_id + actor + refund_credit_note_id)
        // and the REPLAYED admin as actor (actorRole='admin'), NOT the cron.
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'lapsed_member_admin_reactivation_rejected' as const,
            payload: {
              cycle_id: updated.cycleId,
              actor_user_id: asUserId(rejectActorUserId),
              refund_credit_note_id:
                creditNoteId === null ? null : asCreditNoteId(creditNoteId),
            },
          },
          {
            tenantId: cycle.tenantId,
            actorUserId: rejectActorUserId,
            actorRole: 'admin',
            correlationId,
            requestId: null,
          },
        );

        // post_refund_review escalation task — inserted only when a credit note
        // materialised (parity with the sync path, which inserts only when
        // refundCreditNoteId !== null). Idempotent on the open-task index.
        if (creditNoteId !== null) {
          const dueAt = new Date(
            now.getTime() + POST_REFUND_REVIEW_DUE_DAYS * MS_PER_DAY,
          ).toISOString();
          const taskInsert = await deps.escalationTaskRepo.insertIfAbsent(tx, {
            tenantId: cycle.tenantId,
            taskId: asTaskId(randomUUID()),
            memberId: cycle.memberId,
            cycleId,
            taskType: POST_REFUND_REVIEW_TASK_TYPE,
            assignedToRole: 'admin',
            dueAt,
          });
          if (taskInsert.created) {
            await deps.auditEmitter.emitInTx(
              tx,
              {
                type: 'escalation_task_created' as const,
                payload: {
                  task_id: taskInsert.row.taskId,
                  task_type: POST_REFUND_REVIEW_TASK_TYPE,
                  member_id: cycle.memberId as MemberId,
                  cycle_id: cycleId as CycleId,
                  trigger_reason: 'admin_reject_with_refund',
                  refund_credit_note_id: asCreditNoteId(creditNoteId),
                },
              },
              {
                tenantId: cycle.tenantId,
                actorUserId: rejectActorUserId,
                actorRole: 'admin',
                correlationId,
                requestId: null,
                summary: `post_refund_review task created for credit-note ${creditNoteId}`,
              },
            );
          }
        }

        return 'settled_cancelled';
      },
    );
  } catch (e) {
    // F8-RP-2 review fix: a NON-conflict throw from anywhere in the settle
    // tx above (`emitInTx`, `escalationTaskRepo.insertIfAbsent`, the 2nd
    // `emitInTx`, or an unexpected DB blip) lands here. `runInTenant` has
    // already rolled the tx back, so NO partial write landed — the cycle is
    // untouched, still `pending_admin_reactivation` with the marker intact.
    // The next cron pass re-resolves the settlement and retries this same
    // branch from scratch (self-heals, same discipline as
    // `transition_failed_post_refund` on the timeout branch).
    logger.error(
      {
        cycleId,
        tenantId: cycle.tenantId,
        refundId: cycle.rejectRefundId,
        err: e instanceof Error ? e.message : String(e),
      },
      '[reconcile-pending-reactivations] async reject-refund settle tx threw (non-conflict) — tx rolled back, cycle stays marked+pending; next cron pass retries',
    );
    return 'settle_failed';
  }
}

async function processTimeout(
  deps: ReconcilePendingReactivationsDeps,
  cycle: RenewalCycle,
  correlationId: string,
  now: Date,
): Promise<ProcessTimeoutOutcome> {
  const cycleId = cycle.cycleId as CycleId;

  // ---------------------------------------------------------------------
  // Step 1 (MONEY SAFETY — 063 audit fix): re-confirm the cycle is STILL
  // `pending_admin_reactivation` UNDER the per-cycle advisory lock BEFORE
  // issuing the Stripe refund. Mirrors the validate-under-lock → refund-
  // outside-tx → transition-in-tx ordering already used by
  // `adminRejectReactivation` (the F8-canonical refund-a-pending-cycle
  // pattern). The previous ordering refunded FIRST (no lock, no re-read),
  // so an admin who APPROVED the reactivation in the race window — the
  // member paid + was reactivated — still had their money clawed back by
  // the cron. The advisory lock serialises this tx against the admin
  // approve/reject use-cases on the (tenant, cycle) namespace: if the
  // admin's tx committed first, this re-read observes a non-pending
  // status and we skip the refund entirely (the admin's action wins).
  //
  // INVARIANT: an admin approval that lands before this lock MUST prevent
  // the refund. The lock + tx-bound re-read enforce it.
  const stillPending = await runInTenant(deps.tenant, async (tx) => {
    await deps.cyclesRepo.acquireCycleLockInTx(tx, cycle.tenantId, cycleId);
    const reread = await deps.cyclesRepo.findByIdInTx(
      tx,
      cycle.tenantId,
      cycleId,
    );
    return reread !== null && reread.status === 'pending_admin_reactivation';
  });
  if (!stillPending) {
    // A concurrent admin approve (T136 → `completed`) or reject (T137 →
    // `cancelled`, refund already issued) won the race before our lock.
    // Skip silently — no refund, no transition. Counted as
    // `admin_race_skipped` (NOT a timeout, NOT a refund failure).
    logger.info(
      { cycleId, tenantId: cycle.tenantId },
      '[reconcile-pending-reactivations] cycle no longer pending at lock — admin action won race; skipping refund',
    );
    return 'admin_race_skipped';
  }

  // Step 2: refund via F5 (outside tx — Stripe is external; matches the
  // F5 two-tx design + the admin-reject ordering). The advisory lock from
  // Step 1 has been released at COMMIT, so this network call holds no DB
  // lock.
  //
  // Double-refund protection is layered:
  //
  //   PRIMARY SERIALISERS (prevent concurrent in-flight double-refunds):
  //     (a) Route-level per-tenant advisory lock `renewals:reconcile:<tenant>`
  //         (acquired at the top of this POST handler) — serialises overlapping
  //         cron retries for the same tenant so two cron passes cannot both
  //         reach Step 2 concurrently for the same invoice.
  //     (b) F5 `issueRefund` Phase A `SELECT…FOR UPDATE` on the `payments`
  //         row + `pendingCount > 0 → refund_in_progress` guard — detects a
  //         concurrently-in-progress refund from any other code path (admin,
  //         other cron variant) and aborts before calling Stripe.
  //
  //   BACKSTOPS (defence-in-depth for already-completed prior refunds):
  //     (c) `computeRemainingRefundable` counts only `status='succeeded'`
  //         refund rows; if a prior refund settled, it returns null and
  //         `issueRefund` short-circuits without calling Stripe.
  //     (d) Stripe idempotency key per-(invoiceId, attempt) stops the
  //         processor from charging twice even if our guard layers were
  //         somehow bypassed.
  // 063 xhigh fix: track whether a refund was actually issued so the
  // Step-3 forensic logs + classification are accurate. A null-invoice
  // cycle reaches Step 3 with `refundIssued=false` (no money at stake);
  // a refunded/no-payment cycle reaches it with the F5 result recorded.
  let refundIssued = false;
  if (cycle.linkedInvoiceId !== null) {
    // Round 2 (S-9): wrap raw strings in branded IDs at the bridge
    // boundary — see same pattern in admin-reject-reactivation.
    const refundResult = await deps.f5RefundBridge.issueRefundForInvoice({
      tenantId: asTenantId(cycle.tenantId),
      invoiceId: asInvoiceId(cycle.linkedInvoiceId),
      reason: 'auto-timeout: 30-day pending_admin_reactivation expired',
      actorUserId: 'system:cron',
      correlationId,
      requestId: null,
    });
    if (refundResult.status === 'refund_failed') {
      logger.warn(
        {
          cycleId: cycle.cycleId,
          errorCode: refundResult.errorCode,
        },
        '[reconcile-pending-reactivations] F5 refund failed — cycle stays pending; cron will retry tomorrow',
      );
      return 'refund_failed';
    }
    if (refundResult.status === 'refund_pending') {
      // F8-RP: the refund was submitted but is settling ASYNCHRONOUSLY
      // (Stripe pending/requires_action, or a prior refund already in-flight
      // → refund_in_progress). Leave the cycle pending and skip the Step-3
      // transition entirely — the refund row is `pending`, so the
      // `charge.refund.updated` webhook (A.11) / sweep (A.14) settles it and
      // the NEXT cron run self-heals (the bridge then returns
      // `no_payment_found` → normal lapse). Money-safe: the pending row
      // blocks a double refund. Classified distinctly from `refund_failed`
      // (nothing failed) via its own informational counter.
      logger.info(
        {
          cycleId: cycle.cycleId,
          tenantId: cycle.tenantId,
          // `refundId`/`processorRefundId` are optional (absent on the
          // refund_in_progress path); PCI-safe ids only — never card data.
          ...(refundResult.refundId ? { refundId: refundResult.refundId } : {}),
          ...(refundResult.processorRefundId
            ? { processorRefundId: refundResult.processorRefundId }
            : {}),
        },
        '[reconcile-pending-reactivations] F5 refund settling asynchronously — cycle stays pending; next cron run self-heals once the refund confirms',
      );
      return 'refund_pending';
    }
    // `refunded` → money moved; `no_payment_found` → nothing to claw back
    // (cycle entered pending without a settled charge). Only the former
    // marks a money residual if the Step-3 transition is then skipped.
    refundIssued = refundResult.status === 'refunded';
  }

  // Step 3: transition cycle + emit timed_out audit atomically.
  // R4-W1 (staff-review-2026-05-09): use injected `now` for clock
  // determinism — mirrors the WRN-12 fix in `lapseCyclesOnGraceExpiry`.
  // Without this, `closedAt` drifts from the page-cutoff timestamp under
  // heavy cron load and breaks log↔audit correlation.
  const closedAt = now.toISOString();
  // 063 xhigh fix: the tx2 lambda's skip paths (`return;`) used to fall
  // through to the function-level `return 'timed_out'`, silently folding
  // the POST-refund Step-3 residual into a benign timeout. The lambda
  // now COMMUNICATES its terminal outcome via this captured variable so
  // `processTimeout` returns the correct classification. Default
  // `'timed_out'` = the happy path (transition + audit committed); the
  // in-tx skip paths overwrite it to `'post_refund_admin_race'`.
  let tx2Outcome: ProcessTimeoutOutcome = 'timed_out';
  try {
    await runInTenant(deps.tenant, async (tx) => {
      // Re-acquire the per-cycle advisory lock + re-read inside tx2:
      // Step 1 released the lock at COMMIT, then the F5 refund ran
      // unlocked. A concurrent admin approve/reject could land in that
      // window — re-confirm the cycle is still pending before writing
      // the lapse transition. Mirrors `adminRejectReactivation`'s tx2.
      await deps.cyclesRepo.acquireCycleLockInTx(tx, cycle.tenantId, cycleId);
      const reread = await deps.cyclesRepo.findByIdInTx(
        tx,
        cycle.tenantId,
        cycleId,
      );
      // Re-read protects against the admin-approve race: a concurrent
      // T136/T137 moved the cycle out of pending in the Step-3 window
      // (between the refund and this lock). Skip the timeout transition.
      // 063: the refund (if issued) is durable against a now-non-pending
      // cycle — surface this as `post_refund_admin_race` (NOT a benign
      // `timed_out`) so SRE sees the money window. Forensic log records
      // whether a refund actually moved + the status the admin landed on.
      // 063 follow-up: gate the OUTCOME on `refundIssued` — a no-money cycle
      // (no invoice OR `no_payment_found`) has no money window, so it is the
      // same clean no-op as the Step-1 race → `admin_race_skipped`. Only a
      // refund that actually moved makes this the money-orphan residual.
      if (!reread || reread.status !== 'pending_admin_reactivation') {
        tx2Outcome = refundIssued ? 'post_refund_admin_race' : 'admin_race_skipped';
        logger[refundIssued ? 'warn' : 'info'](
          {
            cycleId,
            tenantId: cycle.tenantId,
            refundIssued,
            observedStatus: reread?.status ?? 'not_found',
          },
          refundIssued
            ? '[reconcile-pending-reactivations] POST-refund admin race — refund issued against a now-non-pending cycle (accepted residual #6); cycle is already terminal, no further cron action'
            : '[reconcile-pending-reactivations] admin won the Step-3 window before tx2 lock (no_payment cycle — no money moved); skipping transition',
        );
        return;
      }
      try {
        // I2 review-fix: cron auto-timeout writes
        // `closedReason='pending_reactivation_timed_out'` so the DB row
        // distinguishes a system-driven 30d timeout from an explicit
        // admin reject (which writes `'admin_rejected_with_refund'`).
        // The audit event type already disambiguates
        // (`lapsed_member_admin_reactivation_timed_out` vs `_rejected`),
        // but admins read the lapsed tab badge — they need the row-level
        // distinction without joining audit.
        await deps.cyclesRepo.transitionStatus(tx, cycle.tenantId, cycleId, {
          from: 'pending_admin_reactivation',
          to: 'lapsed',
          closedAt,
          closedReason: 'pending_reactivation_timed_out',
        });
      } catch (e) {
        if (
          e instanceof CycleTransitionConflictError ||
          e instanceof CycleNotFoundError
        ) {
          // Optimistic-lock conflict / not-found — the cycle moved out of
          // pending between our re-read and the transition (a tighter
          // Step-3 race). 063: same money residual as the non-pending
          // re-read above — classify as `post_refund_admin_race`, NOT a
          // fall-through `timed_out`. The refund (if issued) is durable;
          // admin reconciles via F5 refund history. 063 follow-up: gate on
          // `refundIssued` exactly as the non-pending re-read above — a
          // no-money conflict is the clean no-op `admin_race_skipped`.
          tx2Outcome = refundIssued ? 'post_refund_admin_race' : 'admin_race_skipped';
          logger[refundIssued ? 'warn' : 'info'](
            { cycleId, tenantId: cycle.tenantId, refundIssued, err: e.message },
            refundIssued
              ? '[reconcile-pending-reactivations] POST-refund timeout transition lost optimistic-lock race — refund issued against a now-non-pending cycle (accepted residual #6)'
              : '[reconcile-pending-reactivations] timeout transition lost race (no money moved) — skipping',
          );
          return;
        }
        throw e;
      }
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'lapsed_member_admin_reactivation_timed_out' as const,
          payload: {
            cycle_id: cycleId,
            actor_user_id: null,
          },
        },
        {
          tenantId: cycle.tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
        },
      );
    });
  } catch (e) {
    // 063 xhigh fix: tx2 threw a NON-conflict error (DB blip / RLS
    // regression mid-transition or mid-audit-emit). When the refund had
    // already succeeded (`refundIssued`), the OLD code returned
    // `'refund_failed'`, inflating `timeoutRefundFailures` and mislabelling
    // a SUCCEEDED refund as a refund failure. Classify distinctly: the money
    // is durable, the cycle stays pending, and the NEXT cron run re-enters
    // `processTimeout` where F5 short-circuits the second refund (prior
    // refund already settled) and the transition completes — i.e. the cron
    // SELF-HEALS.
    //
    // 063 follow-up: gate the OUTCOME on `refundIssued`. When NO refund
    // moved (no linked invoice OR `no_payment_found`), there is no money at
    // stake — the cycle still self-heals next run, but it must NOT fire the
    // PAGING `transition_failed_post_refund` metric (which exists to page
    // on-call about refunded money stuck on a pending cycle). Route it to the
    // INFORMATIONAL `transition_failed_no_refund` outcome instead so a
    // no-money DB blip never falsely pages. `refundIssued` is carried in the
    // log so the forensic trail shows whether real money awaits the self-heal.
    logger.error(
      {
        cycleId,
        tenantId: cycle.tenantId,
        refundIssued,
        err: e instanceof Error ? e.message : String(e),
      },
      refundIssued
        ? '[reconcile-pending-reactivations] timeout transition threw after refund — refund is durable, cycle stays pending; next cron run self-heals (F5 short-circuits the second refund)'
        : '[reconcile-pending-reactivations] timeout transition threw (no money moved) — cycle stays pending; next cron run self-heals (informational, not a money residual)',
    );
    return refundIssued
      ? 'transition_failed_post_refund'
      : 'transition_failed_no_refund';
  }
  return tx2Outcome;
}
