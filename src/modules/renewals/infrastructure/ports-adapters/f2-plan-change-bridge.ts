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
 * Mirrors the F4 → F8 `f8OnPaidCallbacks` pattern. F3's
 * `changeMemberPlan` use-case threads its tx into the registered
 * listener callbacks atomically.
 *
 * **Failure semantics** (Phase 7 review-fix C-ERR-1):
 *
 * Both listeners fire AFTER F2 has emitted the `member_plan_manually_
 * changed` audit row inside the F3 tx. If a listener throws, the F3
 * tx rolls back the plan-flip + the manual-change audit + every
 * other listener's writes. Inside this file, however, each listener
 * body wraps its inner work in `try/catch + log + metric counter +
 * swallow`. The listener does NOT re-throw. Rationale:
 *
 *   - The F2 plan-flip is the **source of truth**; rolling it back
 *     because F8's bookkeeping had a transient hiccup would lose
 *     admin intent.
 *   - The reconcile cron (T185) catches orphan-pending suggestions
 *     whose target cycle is `cancelled`/`lapsed` — that's defence-
 *     in-depth for the apply-at-renewal path, NOT the supersede
 *     path. A failed supersede leaves a healthy `accepted_pending_
 *     apply` row attached to a still-active cycle which the
 *     reconcile cron will NOT touch.
 *   - To close the supersede observability gap, every swallow bumps
 *     `renewalsMetrics.manualPlanChangeListenerFailed{listener,
 *     tenant_id}`. After Round 4 IMP-8 the reschedule listener
 *     additionally bumps `renewalsMetrics.rescheduleAuditEmitFailed
 *     {audit_type}` for the pgEnum-drift audit-row-loss subcase
 *     (which the runtime DB-fault swallow contract inside the audit
 *     emitter does NOT escape, so wrapListener's counter alone does
 *     not detect it). Both counters together are the alert signals
 *     for this class of failure; Vercel alert rule + on-call runbook
 *     + admin replay tooling are tracked as backlog item
 *     POST-MVP-OBS-7 (`docs/phases-plan.md`). Until that lands,
 *     on-call must grep both metrics on Vercel dashboards manually
 *     if a F2 plan-change incident is suspected.
 *
 * Pure Infrastructure — only `@/lib/db` + `@/lib/logger` +
 * `@/lib/metrics` imports.
 */
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { TenantTx } from '@/lib/db';
import { makeRenewalsDeps } from '../renewals-deps';
import { supersedePendingTierUpgradeInTx } from '../../application/use-cases/supersede-pending-tier-upgrade';
import { rescheduleOnPlanChangeInTx } from '../../application/use-cases/reschedule-on-plan-change';
import type { ManualPlanChangeEvent } from '../../application/ports/manual-plan-change-event';

/**
 * Backward-compatible alias — keeps existing callers compiling while
 * the canonical type now lives in the F8 port. Phase 7 review-fix
 * C-TYPE-1 consolidated the duplicate F3 + F8 shapes.
 *
 * @deprecated Use `ManualPlanChangeEvent` from `@/modules/renewals`.
 */
export type F2ManualPlanChangeEvent = ManualPlanChangeEvent;

/**
 * Listener wrapper — runs `fn(evt, tx)` inside try/catch. On failure
 * logs structured error + bumps the per-tenant per-listener metric
 * counter. Returns void (does NOT re-throw — see file-level rationale).
 */
async function wrapListener(
  listener: 'supersede' | 'reschedule',
  evt: ManualPlanChangeEvent,
  tx: TenantTx,
  fn: (evt: ManualPlanChangeEvent, tx: TenantTx) => Promise<unknown>,
): Promise<void> {
  try {
    await fn(evt, tx);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        listener,
        tenantId: evt.tenantId,
        memberId: evt.memberId,
      },
      `[f8-onManualPlanChange] ${listener} listener failed — F2 audit chain may have a forensic gap; investigate via OTel counter`,
    );
    renewalsMetrics.manualPlanChangeListenerFailed(listener, evt.tenantId);
  }
}

/**
 * F8 listener-callback factory. Returns an array of async callbacks
 * to be invoked by F3's `changeMemberPlan` after the manual-change
 * audit row commits. Each callback runs inside F3's tx — on listener
 * exception the wrapper logs + counts + swallows, so F3's tx commits
 * the plan-flip even if F8 bookkeeping failed.
 */
export function f8OnManualPlanChangeCallbacks(
  tenantId: string,
): ReadonlyArray<
  (evt: ManualPlanChangeEvent, tx: TenantTx) => Promise<void>
> {
  const deps = makeRenewalsDeps(tenantId);
  return [
    // 1. Supersede pending tier-upgrade.
    async (evt, tx) =>
      wrapListener('supersede', evt, tx, async (e, t) => {
        await supersedePendingTierUpgradeInTx(deps, t, {
          tenantId: e.tenantId,
          memberId: e.memberId,
          manualChangeActorUserId: e.actorUserId,
          supersedingPlanId: e.newPlanId,
          correlationId: e.correlationId,
          requestId: e.requestId,
        });
      }),
    // 2. Reschedule renewal cadence diff.
    async (evt, tx) =>
      wrapListener('reschedule', evt, tx, async (e, t) => {
        await rescheduleOnPlanChangeInTx(deps, t, {
          tenantId: e.tenantId,
          memberId: e.memberId,
          oldPlanId: e.oldPlanId,
          newPlanId: e.newPlanId,
          correlationId: e.correlationId,
          requestId: e.requestId,
        });
      }),
  ];
}
