/**
 * T030 — F7 plan-for-member lookup use-case (F2 module).
 *
 * Used by F7's `PlansBridgePort.getPlanForMember` (Phase 3+ T061).
 * Composes:
 *   1. F3 member lookup (via injected `memberLookup` port — F3 plumbs
 *      this from `getMember` in its barrel; keeps F2 → F3 dependency
 *      direction uni-directional via abstraction)
 *   2. F2 plan lookup (via the existing `planRepo.findOne`)
 *   3. Extract `eblast_per_year` from `BenefitMatrix.benefit_matrix`
 *      column → return `{planId, planCode, eblastPerYear}` for FR-002
 *      precondition `a` + FR-009 quota cap derivation.
 *
 * Returns:
 *   - `member_not_found` if F3 lookup misses (caller handles 404 +
 *     cross-tenant probe audit at F7's bridge boundary)
 *   - `plan_not_found` if F2 lookup misses (rare — F2 plan_id snapshot
 *     on the member should always resolve; missing means F2 row was
 *     deleted while a member still references it)
 *   - `member_no_eblast_quota` if `benefit_matrix.eblast_per_year === 0`
 *     (FR-002 precondition `a` rejects free-tier members)
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Plan } from '../domain/plan';
import { asPlanSlug, asPlanYear } from '../domain/plan';
import type { PlanRepo } from './ports';

export type MemberPlanSummary = {
  readonly planId: string;
  readonly planCode: string;
  readonly eblastPerYear: number;
};

export type PlanLookupError =
  | { readonly code: 'plan_lookup.member_not_found'; readonly memberId: string }
  | { readonly code: 'plan_lookup.plan_not_found'; readonly memberId: string }
  | {
      readonly code: 'plan_lookup.member_no_eblast_quota';
      readonly memberId: string;
      readonly planId: string;
    }
  | { readonly code: 'plan_lookup.server_error'; readonly message: string };

/**
 * Minimal port for member identity lookup. F7's bridge adapter wires
 * this to F3's `getMember` use-case via the F3 public barrel (Phase 3+
 * T061). F2 does NOT import F3 directly — keeps the F2 → F3 → F1
 * dependency direction uni-directional.
 */
export interface MemberPlanIdentityLookup {
  findPlanIdentityByMemberId(
    ctx: TenantContext,
    memberId: string,
  ): Promise<
    | { readonly ok: true; readonly value: { planId: string; planYear: number } }
    | { readonly ok: false; readonly code: 'not_found' | 'server_error' }
  >;
}

export type GetPlanForMemberDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly memberLookup: MemberPlanIdentityLookup;
};

export async function getPlanForMember(
  deps: GetPlanForMemberDeps,
  memberId: string,
): Promise<Result<MemberPlanSummary, PlanLookupError>> {
  let memberPlan: { planId: string; planYear: number };
  try {
    const memberLookup = await deps.memberLookup.findPlanIdentityByMemberId(
      deps.tenant,
      memberId,
    );
    if (!memberLookup.ok) {
      if (memberLookup.code === 'not_found') {
        return err({ code: 'plan_lookup.member_not_found', memberId });
      }
      return err({
        code: 'plan_lookup.server_error',
        message: `member lookup failed: ${memberLookup.code}`,
      });
    }
    memberPlan = memberLookup.value;
  } catch (e) {
    return err({
      code: 'plan_lookup.server_error',
      message: `member lookup threw: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

  let plan: Plan | undefined;
  try {
    plan = await deps.planRepo.findOne(
      deps.tenant,
      asPlanSlug(memberPlan.planId),
      asPlanYear(memberPlan.planYear),
    );
  } catch (e) {
    return err({
      code: 'plan_lookup.server_error',
      message: `plan lookup threw: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

  if (!plan) {
    return err({ code: 'plan_lookup.plan_not_found', memberId });
  }

  const eblastPerYear = plan.benefit_matrix.eblast_per_year;
  if (eblastPerYear === 0) {
    return err({
      code: 'plan_lookup.member_no_eblast_quota',
      memberId,
      planId: memberPlan.planId,
    });
  }

  return ok({
    planId: memberPlan.planId,
    planCode: plan.plan_category,
    eblastPerYear,
  });
}
