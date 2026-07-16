/**
 * F9 plan source adapter (US4 / T017) — reads a plan's benefit matrix and maps
 * it to F9's `BenefitEntitlements` (quantifiable quotas + the non-quantified
 * active/unlimited benefits, FR-019/FR-020).
 *
 * Uses the F2 `planRepo.findOne` Infrastructure repo directly — the same
 * documented escape-hatch `broadcasts/infrastructure/plans-bridge.ts` uses
 * (the F2 public barrel cannot re-export the Drizzle repo without dragging
 * postgres/pino into client bundles). A missing plan/year → null (the use-case
 * renders an empty benefit view).
 *
 * `activeBenefits` are stable i18n suffixes (`benefits.active.<key>`) derived
 * from the matrix's boolean/enum flags; presentation localises them. They have
 * no numeric ratio and never enter the under-use aggregate.
 */
import { asPlanSlug, asPlanYear, type BenefitMatrix } from '@/modules/plans';
import { planRepo as drizzlePlanRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import type { TenantContext } from '@/modules/tenants';
import type {
  BenefitEntitlements,
  PlanSource,
} from '../../application/ports/source-ports';

/**
 * Map the benefit matrix's non-quantified flags → stable active-benefit keys.
 * The corporate-only benefits (m2m / referrals / tailor-made) are surfaced ONLY
 * for corporate plans (`partnership === null`); partnership plans store those
 * booleans but do not actually grant them (data-model § 2.2), so a partnership
 * plan gets the `partnership_package` umbrella instead (review-run R#5).
 */
function deriveActiveBenefits(matrix: BenefitMatrix): string[] {
  const keys: string[] = [];
  if (matrix.event_discount_scope === 'all_employees') {
    keys.push('all_employee_event_discount');
  }
  if (matrix.directory_listing_size !== null) keys.push('directory_listing');
  if (matrix.partnership !== null) {
    keys.push('partnership_package');
  } else {
    if (matrix.m2m_benefits_access) keys.push('m2m_benefits');
    if (matrix.business_referrals) keys.push('business_referrals');
    if (matrix.tailor_made_services) keys.push('tailor_made_services');
  }
  return keys;
}

export const planSourceAdapter: PlanSource = {
  async getEntitlements(
    ctx: TenantContext,
    planId: string,
    planYear: number,
  ): Promise<BenefitEntitlements | null> {
    // A member's planId/planYear are F3 brands with NO format validation, but
    // asPlanSlug/asPlanYear THROW on a non-slug / out-of-range value. A member
    // referencing a malformed/legacy plan identity is a "no resolvable plan"
    // case → null (empty benefit view), the documented contract — NOT a 500
    // (review-run R#1).
    let slug;
    let year;
    try {
      slug = asPlanSlug(planId);
      year = asPlanYear(planYear);
    } catch {
      return null;
    }
    const plan = await drizzlePlanRepo.findOne(ctx, slug, year);
    if (!plan) return null;
    const matrix = plan.benefit_matrix;
    return {
      eblastPerYear: matrix.eblast_per_year,
      culturalTicketsPerYear: matrix.cultural_tickets_per_year,
      activeBenefits: deriveActiveBenefits(matrix),
    };
  },

  async getPlanLabel(): Promise<string | null> {
    // stub — implemented in 067 T4/T5
    return null;
  },
};
