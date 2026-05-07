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
  readonly remindersT7: number;
  readonly remindersT3: number;
  readonly remindersT1: number;
  readonly timedOut: number;
  /** Auto-timeouts where the F5 refund failed; cron will retry tomorrow. */
  readonly timeoutRefundFailures: number;
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
 * (`daysPending === REMINDER_T_N`) is now combined with
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

const PENDING_TIMEOUT_DAYS = 30;
const REMINDER_T_7 = 23; // 30 - 7
const REMINDER_T_3 = 27; // 30 - 3
const REMINDER_T_1 = 29; // 30 - 1
const MS_PER_DAY = 86_400_000;

export async function reconcilePendingReactivations(
  deps: ReconcilePendingReactivationsDeps,
  rawInput: ReconcilePendingReactivationsInput,
): Promise<
  Result<
    ReconcilePendingReactivationsOutput,
    ReconcilePendingReactivationsError
  >
> {
  const parsed = reconcilePendingReactivationsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const pageSize = input.pageSize ?? 1000;

  // Single page of pending cycles ordered by entered_pending_at ASC
  // (oldest first — those closest to the 30-day boundary).
  const page = await deps.cyclesRepo.list(input.tenantId, {
    statusFilter: ['pending_admin_reactivation'],
    pageSize,
    sort: 'expires_at_asc',
  });

  let remindersT7 = 0;
  let remindersT3 = 0;
  let remindersT1 = 0;
  let timedOut = 0;
  let timeoutRefundFailures = 0;

  for (const cycle of page.items) {
    const daysPending = computeDaysPending(cycle, input.now);
    if (daysPending === null) continue; // missing entered_pending_at — defensive
    if (daysPending >= PENDING_TIMEOUT_DAYS) {
      const ok = await processTimeout(deps, cycle, input.correlationId);
      if (ok) timedOut += 1;
      else timeoutRefundFailures += 1;
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
        // Read-only audit query failure is non-fatal — fall back to
        // the legacy equality-fire policy so the cron does NOT block
        // on a stale audit-log connection. The next run retries.
        logger.warn(
          {
            cycleId: cycle.cycleId,
            err: e instanceof Error ? e.message : String(e),
          },
          '[reconcile-pending-reactivations] reminderAuditQuery failed — falling back to equality-fire',
        );
        return new Set<ReminderLadderAuditType>();
      });
    const toFire = decideRemindersToFire(daysPending, alreadyEmitted);
    if (toFire.has('lapsed_member_admin_reactivation_reminder_t-7')) {
      await emitReminderAudit(
        deps,
        cycle,
        'lapsed_member_admin_reactivation_reminder_t-7' as const,
        input.correlationId,
      );
      remindersT7 += 1;
    }
    if (toFire.has('lapsed_member_admin_reactivation_reminder_t-3')) {
      await emitReminderAudit(
        deps,
        cycle,
        'lapsed_member_admin_reactivation_reminder_t-3' as const,
        input.correlationId,
      );
      remindersT3 += 1;
    }
    if (toFire.has('lapsed_member_admin_reactivation_reminder_t-1')) {
      await emitReminderAudit(
        deps,
        cycle,
        'lapsed_member_admin_reactivation_reminder_t-1' as const,
        input.correlationId,
      );
      remindersT1 += 1;
    }
  }

  return ok({
    cyclesProcessed: page.items.length,
    remindersT7,
    remindersT3,
    remindersT1,
    timedOut,
    timeoutRefundFailures,
  });
}

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
  if (daysPending >= REMINDER_T_7) {
    if (
      !alreadyEmitted.has('lapsed_member_admin_reactivation_reminder_t-7')
    ) {
      out.add('lapsed_member_admin_reactivation_reminder_t-7');
    }
  }
  if (daysPending >= REMINDER_T_3) {
    if (
      !alreadyEmitted.has('lapsed_member_admin_reactivation_reminder_t-3')
    ) {
      out.add('lapsed_member_admin_reactivation_reminder_t-3');
    }
  }
  if (daysPending >= REMINDER_T_1) {
    if (
      !alreadyEmitted.has('lapsed_member_admin_reactivation_reminder_t-1')
    ) {
      out.add('lapsed_member_admin_reactivation_reminder_t-1');
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

async function emitReminderAudit(
  deps: ReconcilePendingReactivationsDeps,
  cycle: RenewalCycle,
  type:
    | 'lapsed_member_admin_reactivation_reminder_t-7'
    | 'lapsed_member_admin_reactivation_reminder_t-3'
    | 'lapsed_member_admin_reactivation_reminder_t-1',
  correlationId: string,
): Promise<void> {
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
  } catch (e) {
    logger.warn(
      {
        cycleId: cycle.cycleId,
        type,
        err: e instanceof Error ? e.message : String(e),
      },
      '[reconcile-pending-reactivations] reminder audit emit failed',
    );
  }
}

async function processTimeout(
  deps: ReconcilePendingReactivationsDeps,
  cycle: RenewalCycle,
  correlationId: string,
): Promise<boolean> {
  // Step 1: refund via F5 (outside tx — Stripe is external).
  if (cycle.linkedInvoiceId !== null) {
    const refundResult = await deps.f5RefundBridge.issueRefundForInvoice({
      tenantId: cycle.tenantId,
      invoiceId: cycle.linkedInvoiceId,
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
      return false;
    }
  }

  // Step 2: transition cycle + emit timed_out audit atomically.
  const cycleId = cycle.cycleId as CycleId;
  const closedAt = new Date().toISOString();
  try {
    await runInTenant(deps.tenant, async (tx) => {
      await deps.cyclesRepo.acquireCycleLockInTx(tx, cycle.tenantId, cycleId);
      const reread = await deps.cyclesRepo.findByIdInTx(
        tx,
        cycle.tenantId,
        cycleId,
      );
      // Re-read protects against the admin-approve race: a concurrent
      // T136/T137 might have moved the cycle out of pending while we
      // were calling F5. Skip the timeout transition silently.
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
    return false;
  }
  return true;
}
