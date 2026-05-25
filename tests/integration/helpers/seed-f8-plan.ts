/**
 * Wave J12 S2 — shared `seedF8MembershipPlan` helper for F8 integration
 * tests.
 *
 * Replaces the repetitive 19-field `tx.insert(membershipPlans).values({...})`
 * scaffold that appeared in 13 F8 integration test files. Each call site
 * filled in identical defaults (plan_year=2026, plan_category='corporate',
 * member_type_scope='company', annual_fee=5_000_000, plus null-typed
 * optional fields) — only the planId, planName, sortOrder, and
 * benefitMatrix varied.
 *
 * Caller passes the `tenantSlug` (from a `TestTenant.ctx`) + a small
 * `PlanSpec` describing the unique fields. The helper inserts the row
 * inside the caller's existing `runInTenant` transaction.
 *
 * Use:
 *   await runInTenant(tenant.ctx, (tx) =>
 *     seedF8MembershipPlan(tx, {
 *       tenantSlug: tenant.ctx.slug,
 *       planId,
 *       planName: { en: 'F8 Load Plan' },
 *       benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
 *       createdBy: user.userId,
 *     }),
 *   );
 */
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { LocaleText } from '@/modules/plans/domain/locale-text';
import type { TenantTx } from '@/lib/db';

export interface SeedF8PlanSpec {
  readonly tenantSlug: string;
  readonly planId: string;
  readonly planName: LocaleText;
  readonly benefitMatrix: BenefitMatrix;
  readonly createdBy: string;
  readonly updatedBy?: string;
  readonly planYear?: number;
  readonly sortOrder?: number;
  readonly description?: LocaleText;
  readonly annualFeeMinorUnits?: number;
  readonly planCategory?: 'corporate' | 'partnership';
  readonly memberTypeScope?: 'company' | 'individual' | 'both';
  readonly includesCorporatePlanId?: string | null;
  readonly minTurnoverMinorUnits?: number | null;
  readonly maxTurnoverMinorUnits?: number | null;
  readonly maxDurationYears?: number | null;
  readonly maxMemberAge?: number | null;
  readonly isActive?: boolean;
}

export async function seedF8MembershipPlan(
  tx: TenantTx,
  spec: SeedF8PlanSpec,
): Promise<void> {
  await tx.insert(membershipPlans).values({
    tenantId: spec.tenantSlug,
    planId: spec.planId,
    planYear: spec.planYear ?? 2026,
    planName: spec.planName,
    // Non-empty EN default to satisfy the `membership_plans_description_en_non_empty`
    // CHECK constraint (migration 0174, F7.1a/PR #27). The original `{ en: '' }`
    // default predated that constraint and silently produced constraint-violating
    // rows once the dev DB reached head — surfaced by the F9 (015) integration
    // baseline 2026-05-25. Callers needing a specific description still override it.
    description: spec.description ?? { en: 'F8 Test Plan' },
    sortOrder: spec.sortOrder ?? 10,
    planCategory: spec.planCategory ?? 'corporate',
    memberTypeScope: spec.memberTypeScope ?? 'company',
    annualFeeMinorUnits: spec.annualFeeMinorUnits ?? 5_000_000,
    includesCorporatePlanId: spec.includesCorporatePlanId ?? null,
    minTurnoverMinorUnits: spec.minTurnoverMinorUnits ?? null,
    maxTurnoverMinorUnits: spec.maxTurnoverMinorUnits ?? null,
    maxDurationYears: spec.maxDurationYears ?? null,
    maxMemberAge: spec.maxMemberAge ?? null,
    benefitMatrix: spec.benefitMatrix,
    isActive: spec.isActive ?? true,
    createdBy: spec.createdBy,
    updatedBy: spec.updatedBy ?? spec.createdBy,
  });
}
