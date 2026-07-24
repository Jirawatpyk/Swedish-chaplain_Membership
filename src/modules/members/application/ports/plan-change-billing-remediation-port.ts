/**
 * Plan-change → billing remediation (Phase 2) — MEMBERS-owned port for the
 * "immediate mid-cycle re-freeze" that a manual admin change-plan triggers.
 *
 * `changePlan` (F3 members) flips `members.plan_id`; when this optional dep is
 * wired it ALSO reconciles the member's OPEN (not-yet-invoiced) renewal cycle
 * to the new plan — re-freezing it immediately (flag on) or deferring to the
 * next cycle (flag off / an issued §86/4 / a term-length change / no open
 * cycle). The IMPLEMENTATION lives in a renewals adapter (it reaches the F8
 * cycle repo + the F4 invoice-due bridge + the F2 plan-lookup + the audit
 * port); members owns the CONTRACT so the dependency points renewals → members
 * (Constitution Principle III — Application orchestrates its OWN ports).
 *
 * The method runs on `change-plan`'s tx (threaded), never a nested
 * `runInTenant`, so the re-freeze + audit commit ATOMICALLY with the plan flip
 * (Constitution Principle VIII) and never open a second pooled connection while
 * change-plan holds the member FOR UPDATE lock (deadlock-avoidance).
 *
 * Pure interface — no framework imports beyond the shared `TenantTx` tx handle
 * (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';

/**
 * The billing consequence of a manual plan change, as observed by the OPEN
 * renewal cycle. This is the SUBSET of the shared
 * `member_plan_change_billing_effect` audit taxonomy that the change-plan
 * operation can produce (the `seed_fallback_plan_unresolvable` +
 * `tier_upgrade_target_unresolvable` variants belong to the F8 seed / tier-
 * upgrade seams, never to change-plan):
 *
 *   - `applied_to_open_cycle`         — the open cycle was re-frozen to the new
 *                                       plan/price this cycle (flag ON);
 *   - `deferred_invoice_already_issued` — an issued membership §86/4 exists for
 *                                       the member (or the cycle is already
 *                                       linked), so the cycle is left untouched
 *                                       (never rewrite a tax invoice);
 *   - `deferred_term_length_change`   — the new plan's term differs from the
 *                                       cycle's frozen term; period re-derivation
 *                                       is out of scope, so the cycle defers;
 *   - `deferred_immediate_not_enabled` — the FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE
 *                                       flag is off; the change defers to the
 *                                       next cycle (Phase-1 behaviour);
 *   - `no_open_cycle`                 — the member has no open cycle to re-freeze.
 */
export type PlanChangeBillingEffectKind =
  | 'applied_to_open_cycle'
  | 'deferred_invoice_already_issued'
  | 'deferred_term_length_change'
  | 'deferred_immediate_not_enabled'
  | 'no_open_cycle';

/**
 * The remediation outcome threaded back onto the `changePlan` result. `effect`
 * is the discriminant; `cycleId` names the affected open cycle (null when there
 * was none); `blockingInvoiceId` is set ONLY for
 * `deferred_invoice_already_issued` (the issued §86/4 that blocked the
 * re-freeze). A later UI task renders "applied now" vs "applies next cycle".
 */
export interface PlanChangeBillingEffect {
  readonly effect: PlanChangeBillingEffectKind;
  readonly cycleId: string | null;
  readonly blockingInvoiceId: string | null;
}

export interface PlanChangeBillingRemediationContext {
  readonly tenantId: string;
  readonly memberId: string;
  /** The member's plan BEFORE the flip (captured under the member FOR UPDATE lock). */
  readonly oldPlanId: string;
  readonly newPlanId: string;
  readonly newPlanYear: number;
  readonly actorUserId: string;
  readonly correlationId: string;
}

export interface PlanChangeBillingRemediationPort {
  /**
   * Reconcile the member's OPEN renewal cycle to the just-flipped plan, on the
   * caller's tx (atomic with the plan flip + audits). ALWAYS emits a
   * `member_plan_change_billing_effect` audit row (via the renewals audit port)
   * describing the outcome. THROWS on any infra failure so `change-plan`'s tx
   * rolls back — never fire-and-forget.
   */
  applyPlanChangeToBillingInTx(
    tx: TenantTx,
    ctx: PlanChangeBillingRemediationContext,
  ): Promise<PlanChangeBillingEffect>;
}
