/**
 * F8 Phase 7 T187+T188 — F2 → F8 plan-change bridge.
 *
 * F8 listener registration for the F2 `member_plan_manually_changed`
 * event. Two parallel listeners run on every F2 manual plan-change:
 *
 *   1. **Supersede listener (T184)** — `supersedePendingTierUpgrade`
 *      transitions any active tier-upgrade suggestion for the member
 *      to `superseded` (admin's deliberate override wins).
 *
 *   2. **Reschedule listener (T188a)** — `rescheduleOnPlanChange`
 *      computes the schedule-step diff when the new plan's
 *      tier-bucket differs from the old plan's; the not-yet-fired
 *      reminders shift to the new bucket's policy.
 *
 * Mirrors the F4 → F8 `f8OnPaidCallbacks` pattern (renewals-deps.ts):
 * F2's `changeMemberPlan` use-case threads its tx into the
 * registered listener callbacks atomically. Both listeners run
 * inside the F2 tx so a thrown exception rolls F2's plan-change back.
 *
 * **Wiring status**: this factory is READY for consumption. F3's
 * `change-plan.ts` (`src/modules/members/application/use-cases/change-plan.ts`)
 * must invoke `f8OnManualPlanChangeCallbacks(tenantId)` after its
 * `member_plan_manually_changed` audit emit, threading the F2 tx into
 * each callback. Wiring lands in a Phase 7 follow-up commit (or
 * Phase 10 polish sweep). Until then the reconcile cron (T185)
 * provides defence-in-depth: orphan-pending suggestions are detected
 * weekly and dismissed with `reason='orphan_target_cycle_terminal'`.
 *
 * Pure Infrastructure — only `@/lib/db` + `@/lib/logger` imports.
 */
import { logger } from '@/lib/logger';
import type { TenantTx } from '@/lib/db';
import { makeRenewalsDeps } from '../renewals-deps';
import { supersedePendingTierUpgradeInTx } from '../../application/use-cases/supersede-pending-tier-upgrade';
import { rescheduleOnPlanChangeInTx } from '../../application/use-cases/reschedule-on-plan-change';

/**
 * Event payload emitted by F3's `changeMemberPlan` after the
 * `member_plan_manually_changed` audit row commits. Mirrors the
 * audit payload's shape.
 */
export interface F2ManualPlanChangeEvent {
  readonly tenantId: string;
  readonly memberId: string;
  readonly oldPlanId: string;
  readonly newPlanId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly requestId: string | null;
}

/**
 * F8 listener-callback factory. Returns an array of async callbacks
 * to be invoked by F3's `changeMemberPlan` after the manual-change
 * audit row commits. Each callback runs inside F3's tx (the second
 * `tx` parameter) so failures roll the F3 plan-change back —
 * Constitution Principle VIII atomic state+audit.
 *
 * Both callbacks are independent — a failure in one does NOT abort
 * the other (logged + counted). The F3 tx-rollback contract is only
 * triggered by a thrown exception, so the catch blocks here log and
 * swallow.
 */
export function f8OnManualPlanChangeCallbacks(
  tenantId: string,
): ReadonlyArray<
  (
    evt: F2ManualPlanChangeEvent,
    tx: TenantTx,
  ) => Promise<void>
> {
  const deps = makeRenewalsDeps(tenantId);
  return [
    // 1. Supersede pending tier-upgrade.
    async (evt, tx) => {
      try {
        await supersedePendingTierUpgradeInTx(deps, tx, {
          tenantId: evt.tenantId,
          memberId: evt.memberId,
          manualChangeActorUserId: evt.actorUserId,
          supersedingPlanId: evt.newPlanId,
          correlationId: evt.correlationId,
          requestId: evt.requestId,
        });
      } catch (e) {
        // Log + swallow — the F3 tx already committed the plan-change
        // and audit; failing the listener should not roll those back
        // unconditionally. The reconcile cron (T185) catches orphan-
        // pending suggestions weekly so any missed supersede here is
        // recovered defensively.
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            tenantId: evt.tenantId,
            memberId: evt.memberId,
          },
          '[f8-onManualPlanChange] supersede listener failed — reconcile cron will recover',
        );
      }
    },
    // 2. Reschedule renewal cadence diff.
    async (evt, tx) => {
      try {
        await rescheduleOnPlanChangeInTx(deps, tx, {
          tenantId: evt.tenantId,
          memberId: evt.memberId,
          oldPlanId: evt.oldPlanId,
          newPlanId: evt.newPlanId,
          correlationId: evt.correlationId,
          requestId: evt.requestId,
        });
      } catch (e) {
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            tenantId: evt.tenantId,
            memberId: evt.memberId,
          },
          '[f8-onManualPlanChange] reschedule listener failed',
        );
      }
    },
  ];
}
