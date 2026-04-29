/**
 * T028 — `PlansBridgePort` Application port (F7).
 *
 * Cross-module read against F2 (`@/modules/plans` public barrel).
 * Used by `submit-broadcast.ts` for FR-002 precondition `a` (member's
 * plan must include broadcasts entitlement) + FR-009 (cap = plan's
 * `eblastPerYear`) + benefits page entitlement display.
 *
 * Concrete adapter (Phase 4 Infrastructure) calls F2's
 * `getPlanForMember` export added in T030 (Batch C).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantContext } from '@/modules/tenants';
import type { Result } from '@/lib/result';

export type PlanLookupError =
  | { readonly kind: 'plan_lookup.member_not_found'; readonly memberId: string }
  | { readonly kind: 'plan_lookup.member_no_plan'; readonly memberId: string }
  | { readonly kind: 'plan_lookup.plan_not_found'; readonly planId: string };

export interface MemberPlanSummary {
  readonly planId: string;
  readonly planCode: string;
  readonly eblastPerYear: number;
}

export interface PlansBridgePort {
  /**
   * Look up the member's current membership plan summary (FR-002 precondition `a` +
   * FR-009 + benefits page).
   *
   * Returns `err({...})` if the member is not on an active plan or
   * the plan has no broadcasts entitlement (`eblastPerYear === 0`).
   */
  getPlanForMember(
    tenantCtx: TenantContext,
    memberId: string,
  ): Promise<Result<MemberPlanSummary, PlanLookupError>>;
}
