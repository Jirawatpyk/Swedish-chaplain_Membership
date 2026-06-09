/**
 * F8 Phase 5 Wave B · T138 — `reconcilePendingReactivations`.
 *
 * Daily cron walking cycles in `pending_admin_reactivation` to:
 *
 *   1. Emit `_reminder_t-7` audit at 23 days since `entered_pending_at`
 *   2. Emit `_reminder_t-3` audit at 27 days
 *   3. Emit `_reminder_t-1` audit at 29 days
 *   4. Auto-timeout at >= 30 days: cancel cycle + refund via F5 +
 *      emit `_timed_out` audit (actor=cron, null userId)
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
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { asTenantId } from '@/modules/members';
import { asInvoiceId } from '@/modules/invoicing';
import { parseInput } from './_lib/parse-input';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { F5RefundBridge } from '../ports/f5-refund-bridge';
import type {
  CycleId,
  RenewalCycle,
} from '../../domain/renewal-cycle';
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
    'tenant' | 'cyclesRepo' | 'auditEmitter'
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
  let timeoutAdminRaceSkipped = 0;

  for (const cycle of page.items) {
    const daysPending = computeDaysPending(cycle, input.now);
    if (daysPending === null) continue; // missing entered_pending_at — defensive
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
        case 'admin_race_skipped':
          timeoutAdminRaceSkipped += 1;
          renewalsMetrics.timeoutAdminRaceSkipped(cycle.tenantId);
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
      continue;
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

  return ok({
    cyclesProcessed: page.items.length,
    remindersT7: reminderCounters['lapsed_member_admin_reactivation_reminder_t-7'],
    remindersT3: reminderCounters['lapsed_member_admin_reactivation_reminder_t-3'],
    remindersT1: reminderCounters['lapsed_member_admin_reactivation_reminder_t-1'],
    remindersFailed,
    timedOut,
    timeoutRefundFailures,
    timeoutAdminRaceSkipped,
  });
}

/**
 * Outcome of `processTimeout` for one timed-out cycle. Three terminal
 * states — counted independently by the caller (parity with
 * `lapseCyclesOnGraceExpiry`'s `ProcessOneOutcome`):
 *   - `'timed_out'`        — refund issued (or no payment) + cycle lapsed.
 *   - `'refund_failed'`    — F5/Stripe refund failed; cron retries tomorrow.
 *   - `'admin_race_skipped'` — admin approve/reject won the lock race
 *     before the refund; NO money moved, NO transition.
 */
type ProcessTimeoutOutcome =
  | 'timed_out'
  | 'refund_failed'
  | 'admin_race_skipped';

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
  }

  // Step 3: transition cycle + emit timed_out audit atomically.
  // R4-W1 (staff-review-2026-05-09): use injected `now` for clock
  // determinism — mirrors the WRN-12 fix in `lapseCyclesOnGraceExpiry`.
  // Without this, `closedAt` drifts from the page-cutoff timestamp under
  // heavy cron load and breaks log↔audit correlation.
  const closedAt = now.toISOString();
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
      // T136/T137 might have moved the cycle out of pending while we
      // were calling F5. Skip the timeout transition silently. The
      // refund (if issued) is durable; admin reconciles via F5 history.
      if (!reread || reread.status !== 'pending_admin_reactivation') {
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
          // Race / not-found — silently skip. Refund (if issued) is
          // durable; admin can reconcile via F5 refund history.
          logger.warn(
            { cycleId, err: e.message },
            '[reconcile-pending-reactivations] timeout transition lost race — skipping',
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
    logger.error(
      {
        cycleId,
        err: e instanceof Error ? e.message : String(e),
      },
      '[reconcile-pending-reactivations] timeout transition failed',
    );
    return 'refund_failed';
  }
  return 'timed_out';
}
