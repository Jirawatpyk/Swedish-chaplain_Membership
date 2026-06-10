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
/**
 * Event payload emitted by F3's `changeMemberPlan` AFTER its tx (the
 * plan-flip + `member_plan_manually_changed` audit) has COMMITTED.
 * Mirrors the audit payload shape so listeners can correlate with the
 * audit log.
 *
 * 063 (Option A) — listeners are dispatched post-commit, not in-tx; see
 * the `ManualPlanChangeListener` doc for the consistency model.
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
 * Listener signature for F3's `changeMemberPlan` to invoke
 * POST-COMMIT (063, Option A). Each listener runs in its OWN tenant
 * transaction (re-establishing RLS) and is best-effort: it receives the
 * event only — NOT F3's tx. A listener failure is logged + counted by
 * the F8 bridge and does NOT roll back F3's already-committed plan-flip.
 *
 * The old in-tx contract (listener takes F3's `tx`, a throw rolls the
 * plan-change back) could not actually deliver its swallow guarantee: a
 * hard SQL failure poisoned the Postgres tx → COMMIT downgraded to
 * ROLLBACK → the plan-flip was silently lost regardless of the swallow.
 * Option A makes the plan-flip atomic and the bookkeeping eventual.
 */
export type ManualPlanChangeListener = (
  evt: ManualPlanChangeEvent,
) => Promise<void>;
