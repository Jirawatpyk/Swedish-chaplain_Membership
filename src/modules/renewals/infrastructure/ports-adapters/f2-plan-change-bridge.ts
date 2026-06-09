/**
 * F8 Phase 7 T187+T188 / 063 (Option A) — F2 → F8 plan-change bridge.
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
 * Mirrors the POST-tx half of the F4 → F8 `f8OnPaidCallbacks` pattern
 * (where the F2 finaliser also runs in its own `runInTenant` after F4
 * commits).
 *
 * **Failure semantics** (063 Option A — corrected):
 *
 * F3's `changeMemberPlan` invokes these callbacks POST-COMMIT — AFTER
 * the plan-flip + `member_plan_manually_changed` audit row have
 * committed durably. Each callback here calls the NON-`InTx` use-case
 * variant (`supersedePendingTierUpgrade` / `rescheduleOnPlanChange`),
 * which opens its OWN `runInTenant(deps.tenant, …)` tx (re-establishing
 * RLS) and returns a `Result` (it never throws — it catches internally).
 *
 * The callbacks are best-effort. Each wraps its work in
 * `wrapListener`, which logs + bumps
 * `renewalsMetrics.manualPlanChangeListenerFailed{listener,tenant_id}`
 * when the use-case returns an err (or throws). The swallow NOW GENUINELY
 * works: a post-commit own-tx failure cannot touch the already-committed
 * plan-flip. This is the whole point of 063 Option A.
 *
 * The PRIOR design ran the listeners INSIDE F3's tx with the shared
 * `tx`. The swallow there could not deliver its guarantee: a hard SQL
 * failure (RLS / NOT-NULL / pgEnum drift) poisons the Postgres tx, so
 * F3's COMMIT downgrades to ROLLBACK and the plan-flip is silently lost
 * — exactly what the swallow was meant to prevent. (The
 * `rescheduleOnPlanChange` use-case had already partially worked around
 * this in Round 4 CRIT-1 by emitting its audit rows via `emit()` /
 * own-tx; Option A completes the fix uniformly for BOTH listeners,
 * including the supersede `transitionStatus` write.)
 *
 *   - The F2 plan-flip is the **source of truth** and is now atomic +
 *     durable on its own. F8 bookkeeping (supersede / reschedule) is
 *     post-commit eventual.
 *   - The reconcile cron (T185) catches orphan-pending suggestions
 *     whose target cycle is `cancelled`/`lapsed` (the apply-at-renewal
 *     path) plus a `manual_plan_change` divergence path
 *     (`orphan_member_plan_diverged`). A failed supersede on a STILL-
 *     ACTIVE cycle is the PRE-EXISTING, documented gap — it leaves a
 *     healthy `accepted_pending_apply` row attached to an active cycle
 *     which the reconcile cron does NOT currently touch. Option A does
 *     not make this gap worse: previously a failed supersede rolled the
 *     plan-flip back entirely, which is strictly worse. (Reconciling the
 *     supersede-orphan on an active cycle is a tracked follow-up, NOT in
 *     this change.)
 *   - To keep the supersede observability, every swallow bumps
 *     `renewalsMetrics.manualPlanChangeListenerFailed{listener,
 *     tenant_id}`. The reschedule use-case additionally bumps
 *     `renewalsMetrics.rescheduleAuditEmitFailed{audit_type}` for the
 *     pgEnum-drift audit-row-loss subcase (which its internal own-tx
 *     emit swallow does NOT surface to this bridge's Result). Both
 *     counters together are the alert signals for this class of failure;
 *     Vercel alert rule + on-call runbook + admin replay tooling are
 *     tracked as backlog item POST-MVP-OBS-7 (`docs/phases-plan.md`).
 *     Until that lands, on-call must grep both metrics on Vercel
 *     dashboards manually if a F2 plan-change incident is suspected.
 *
 * Pure Infrastructure — only `@/lib/logger` + `@/lib/metrics` + F8
 * application use-cases + `makeRenewalsDeps` imports.
 */
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { makeRenewalsDeps } from '../renewals-deps';
import { supersedePendingTierUpgrade } from '../../application/use-cases/supersede-pending-tier-upgrade';
import { rescheduleOnPlanChange } from '../../application/use-cases/reschedule-on-plan-change';
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
 * Minimal Result shape the wrapped use-cases return. We only need the
 * discriminant + an optional error to log — the success value is
 * irrelevant to the post-commit best-effort contract.
 */
type ListenerResult = {
  readonly ok: boolean;
  readonly error?: unknown;
};

/**
 * Extracts a loggable message from a use-case error value (which may be
 * `{ kind, message }`, an Error, or an arbitrary value).
 */
function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Listener wrapper (063 Option A) — runs `fn(evt)` (the non-`InTx`
 * use-case, which opens its own tenant tx). On a thrown error OR a
 * returned `{ ok: false }`, logs a structured error + bumps the
 * per-tenant per-listener metric counter. Returns void (does NOT
 * re-throw — the plan-flip is already committed; see file-level
 * rationale). The bridge's swallow is now genuinely safe because the
 * use-case runs in its OWN post-commit tx.
 */
async function wrapListener(
  listener: 'supersede' | 'reschedule',
  evt: ManualPlanChangeEvent,
  fn: (evt: ManualPlanChangeEvent) => Promise<ListenerResult>,
): Promise<void> {
  try {
    const result = await fn(evt);
    if (!result.ok) {
      logger.error(
        {
          err: errMessage(result.error),
          listener,
          tenantId: evt.tenantId,
          memberId: evt.memberId,
        },
        `[f8-onManualPlanChange] ${listener} listener returned err (post-commit) — plan-flip already durable; counter bumped, orphan left for replay`,
      );
      renewalsMetrics.manualPlanChangeListenerFailed(listener, evt.tenantId);
    }
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        listener,
        tenantId: evt.tenantId,
        memberId: evt.memberId,
      },
      `[f8-onManualPlanChange] ${listener} listener threw (post-commit) — plan-flip already durable; counter bumped, orphan left for replay`,
    );
    renewalsMetrics.manualPlanChangeListenerFailed(listener, evt.tenantId);
  }
}

/**
 * F8 listener-callback factory (063 Option A). Returns an array of async
 * callbacks invoked by F3's `changeMemberPlan` POST-COMMIT — after the
 * plan-flip + `member_plan_manually_changed` audit have committed
 * durably. Each callback runs the corresponding F8 use-case in its OWN
 * `runInTenant` tx (the use-case opens it). On failure the wrapper logs
 * + counts + swallows, so an F8 bookkeeping hiccup does NOT (and now
 * genuinely CANNOT) roll back the already-committed plan-flip.
 */
export function f8OnManualPlanChangeCallbacks(
  tenantId: string,
): ReadonlyArray<(evt: ManualPlanChangeEvent) => Promise<void>> {
  const deps = makeRenewalsDeps(tenantId);
  return [
    // 1. Supersede pending tier-upgrade — own tx via non-`InTx` variant.
    async (evt) =>
      wrapListener('supersede', evt, (e) =>
        supersedePendingTierUpgrade(deps, {
          tenantId: e.tenantId,
          memberId: e.memberId,
          manualChangeActorUserId: e.actorUserId,
          supersedingPlanId: e.newPlanId,
          correlationId: e.correlationId,
          requestId: e.requestId,
        }),
      ),
    // 2. Reschedule renewal cadence diff — own tx via non-`InTx` variant.
    async (evt) =>
      wrapListener('reschedule', evt, (e) =>
        rescheduleOnPlanChange(deps, {
          tenantId: e.tenantId,
          memberId: e.memberId,
          oldPlanId: e.oldPlanId,
          newPlanId: e.newPlanId,
          correlationId: e.correlationId,
          requestId: e.requestId,
        }),
      ),
  ];
}
