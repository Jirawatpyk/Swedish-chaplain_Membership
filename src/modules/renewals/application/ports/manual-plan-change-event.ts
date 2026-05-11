/**
 * F8 Phase 7 — Canonical `ManualPlanChangeEvent` event shape, owned
 * by the F8 module (the consumer of the F2 `member_plan_manually_
 * changed` audit fire).
 *
 * Originally duplicated across:
 *   - F3 `change-plan.ts` (`ManualPlanChangeListenerEvent`)
 *   - F8 `f2-plan-change-bridge.ts` (`F2ManualPlanChangeEvent`)
 *
 * Phase 7 review-fix C-TYPE-1: the duplication was structurally
 * identical but a future field rename or addition would silently
 * drift between the two definitions. Consolidated here so F3's
 * `ChangePlanDeps.manualPlanChangeListeners` slot and F8's
 * `f8OnManualPlanChangeCallbacks` factory share the SAME type.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';

/**
 * Event payload emitted by F3's `changeMemberPlan` after the
 * `member_plan_manually_changed` audit row commits. Mirrors the
 * audit payload shape so listeners can correlate with audit log.
 */
export interface ManualPlanChangeEvent {
  readonly tenantId: string;
  readonly memberId: string;
  readonly oldPlanId: string;
  readonly newPlanId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly requestId: string | null;
}

/**
 * Listener signature for F3's `changeMemberPlan` to invoke. Each
 * listener runs inside the F3 tx (the `tx` param) so failures roll
 * the F3 plan-change back per Constitution Principle VIII.
 */
export type ManualPlanChangeListener = (
  evt: ManualPlanChangeEvent,
  tx: TenantTx,
) => Promise<void>;
