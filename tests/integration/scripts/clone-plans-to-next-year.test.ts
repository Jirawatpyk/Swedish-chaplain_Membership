/**
 * Integration test: scripts/clone-plans-to-next-year.ts
 *
 * Verifies the next-FY catalogue pre-seed:
 *   - dry-run reports the active source plans + mutates nothing
 *   - --apply clones every active source plan into TARGET_YEAR with
 *     `is_active = false`, identical fees / benefit_matrix / names /
 *     tier bucket, and one `plan_created` audit event each
 *   - the source-year rows are left UNCHANGED (incl. still active)
 *   - a re-run is an idempotent no-op (already-seeded skip)
 *   - soft-deleted + inactive source plans are NOT cloned
 *   - the year-gap guard (pure helper) refuses an implausible gap
 *
 * Runs against live Neon via a throwaway `test-*` tenant (swept by
 * `clear-test-data.ts` if a teardown is skipped). Uses the same
 * harness helpers as `tests/integration/scripts/*.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import {
  clonePlansToNextYear,
  emitCloneAudits,
  resolveYears,
  CloneYearGapError,
} from '@/../scripts/clone-plans-to-next-year';
import { createTestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser } from '../helpers/test-users';

const SOURCE_YEAR = 2030;
const TARGET_YEAR = 2031;

const PREMIUM_MATRIX: BenefitMatrix = {
  eblast_per_year: 6,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'premium',
  directory_listing_size: 'full_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: true,
  cultural_tickets_per_year: 2,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: true,
  partnership: null,
};

const REGULAR_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

describe('Integration — clone-plans-to-next-year', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  // -- pure helper: year-gap guard ------------------------------------------

  it('resolveYears refuses a non-adjacent target unless ALLOW_YEAR_GAP override', () => {
    // Adjacent year is fine.
    expect(
      resolveYears({ sourceYear: 2030, targetYear: 2031 }),
    ).toEqual({ sourceYear: 2030, targetYear: 2031 });

    // Default target = source + 1.
    expect(resolveYears({ sourceYear: 2030 })).toEqual({
      sourceYear: 2030,
      targetYear: 2031,
    });

    // Implausible gap is refused...
    expect(() =>
      resolveYears({ sourceYear: 2030, targetYear: 2035 }),
    ).toThrow(CloneYearGapError);

    // ...unless explicitly allowed.
    expect(
      resolveYears({ sourceYear: 2030, targetYear: 2035, allowGap: true }),
    ).toEqual({ sourceYear: 2030, targetYear: 2035 });
  });

  // -- end-to-end clone ------------------------------------------------------

  it('clones active source plans into the target year as inactive, faithfully, with audits; leaves sources unchanged; idempotent', async () => {
    const tenant = await createTestTenant('test-swecham');
    cleanups.push(tenant.cleanup);

    const owner = await createActiveTestUser();
    cleanups.push(() => deleteTestUser(owner));

    // Seed SOURCE_YEAR catalogue:
    //   - 'premium'  active, tier = 'premium'    (clonable)
    //   - 'regular'  active, tier = 'regular'    (clonable)
    //   - 'inactive' is_active = false           (NOT clonable)
    //   - 'deleted'  soft-deleted                (NOT clonable)
    // Tier buckets are deliberately NOT all 'regular' so the test
    // proves the clone carries `renewal_tier_bucket` rather than
    // resetting it to the column default 'regular' (the F2 repo bug
    // this script's raw insert sidesteps).
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values([
        {
          tenantId: tenant.ctx.slug,
          planId: 'premium',
          planYear: SOURCE_YEAR,
          planName: { en: 'Premium Corporate', th: 'พรีเมียม', sv: 'Premium' },
          description: { en: 'Premium tier', th: 'พรีเมียม', sv: 'Premium' },
          sortOrder: 10,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 3_600_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: 10_000_000_000,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: PREMIUM_MATRIX,
          renewalTierBucket: 'premium',
          isActive: true,
          createdBy: owner.userId,
          updatedBy: owner.userId,
        },
        {
          tenantId: tenant.ctx.slug,
          planId: 'regular',
          planYear: SOURCE_YEAR,
          planName: { en: 'Regular Corporate', th: 'ทั่วไป', sv: 'Vanlig' },
          description: { en: 'Regular tier', th: 'ทั่วไป', sv: 'Vanlig' },
          sortOrder: 30,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 1_600_000,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: 5_000_000_000,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: REGULAR_MATRIX,
          renewalTierBucket: 'regular',
          isActive: true,
          createdBy: owner.userId,
          updatedBy: owner.userId,
        },
        {
          tenantId: tenant.ctx.slug,
          planId: 'inactive-tier',
          planYear: SOURCE_YEAR,
          planName: { en: 'Inactive Tier' },
          description: { en: 'd' },
          sortOrder: 40,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 1_000_000,
          benefitMatrix: REGULAR_MATRIX,
          renewalTierBucket: 'regular',
          isActive: false,
          createdBy: owner.userId,
          updatedBy: owner.userId,
        },
        {
          tenantId: tenant.ctx.slug,
          planId: 'deleted-tier',
          planYear: SOURCE_YEAR,
          planName: { en: 'Deleted Tier' },
          description: { en: 'd' },
          sortOrder: 50,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 1_000_000,
          benefitMatrix: REGULAR_MATRIX,
          renewalTierBucket: 'regular',
          isActive: true,
          deletedAt: new Date(),
          createdBy: owner.userId,
          updatedBy: owner.userId,
        },
      ]);
    });

    // --- DRY-RUN: reports the 2 active candidates, mutates nothing ---------
    const dryReport = await clonePlansToNextYear(tenant.ctx, owner.userId, {
      sourceYear: SOURCE_YEAR,
      targetYear: TARGET_YEAR,
      apply: false,
    });
    expect(dryReport.skippedAlreadySeeded).toBe(false);
    expect(dryReport.candidates.map((c) => c.planId).sort()).toEqual([
      'premium',
      'regular',
    ]);
    expect(dryReport.cloned).toHaveLength(0);

    // No TARGET_YEAR rows yet (dry-run mutated nothing).
    const afterDry = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(eq(membershipPlans.planYear, TARGET_YEAR)),
    );
    expect(afterDry).toHaveLength(0);

    // --- APPLY: clones the 2 active plans as inactive ----------------------
    const applyReport = await clonePlansToNextYear(tenant.ctx, owner.userId, {
      sourceYear: SOURCE_YEAR,
      targetYear: TARGET_YEAR,
      apply: true,
    });
    expect(applyReport.skippedAlreadySeeded).toBe(false);
    expect(applyReport.cloned.map((c) => c.planId).sort()).toEqual([
      'premium',
      'regular',
    ]);
    await emitCloneAudits(
      tenant.ctx,
      owner.userId,
      applyReport.cloned,
      TARGET_YEAR,
    );

    // TARGET_YEAR rows exist, inactive, faithful copies.
    const targetRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(eq(membershipPlans.planYear, TARGET_YEAR))
        .orderBy(membershipPlans.planId),
    );
    expect(targetRows.map((r) => r.planId)).toEqual(['premium', 'regular']);

    const premiumTarget = targetRows.find((r) => r.planId === 'premium')!;
    expect(premiumTarget.isActive).toBe(false);
    expect(premiumTarget.deletedAt).toBeNull();
    expect(premiumTarget.planYear).toBe(TARGET_YEAR);
    // Same fee ("ใช้ของเดิม").
    expect(premiumTarget.annualFeeMinorUnits).toBe(3_600_000);
    // Faithful tier bucket — NOT reset to 'regular' default.
    expect(premiumTarget.renewalTierBucket).toBe('premium');
    // Identical jsonb name + matrix.
    expect(premiumTarget.planName).toEqual({
      en: 'Premium Corporate',
      th: 'พรีเมียม',
      sv: 'Premium',
    });
    expect(premiumTarget.benefitMatrix).toEqual(PREMIUM_MATRIX);
    expect(premiumTarget.minTurnoverMinorUnits).toBe(10_000_000_000);
    // Fresh owner threaded through.
    expect(premiumTarget.createdBy).toBe(owner.userId);
    expect(premiumTarget.updatedBy).toBe(owner.userId);

    const regularTarget = targetRows.find((r) => r.planId === 'regular')!;
    expect(regularTarget.isActive).toBe(false);
    expect(regularTarget.renewalTierBucket).toBe('regular');
    expect(regularTarget.annualFeeMinorUnits).toBe(1_600_000);

    // --- SOURCE rows UNCHANGED (still active, original year) ---------------
    const sourceRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(eq(membershipPlans.planYear, SOURCE_YEAR))
        .orderBy(membershipPlans.planId),
    );
    const premiumSource = sourceRows.find((r) => r.planId === 'premium')!;
    expect(premiumSource.isActive).toBe(true); // still active
    expect(premiumSource.planYear).toBe(SOURCE_YEAR);
    expect(premiumSource.annualFeeMinorUnits).toBe(3_600_000);

    // --- AUDIT: one plan_created per cloned plan, for TARGET_YEAR ----------
    const audits = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_created'),
            sql`(${auditLog.payload}->>'plan_year')::int = ${TARGET_YEAR}`,
          ),
        ),
    );
    expect(audits).toHaveLength(2);
    const auditedPlanIds = audits
      .map((a) => (a.payload as { plan_id: string }).plan_id)
      .sort();
    expect(auditedPlanIds).toEqual(['premium', 'regular']);

    // --- IDEMPOTENT: re-run is a no-op skip --------------------------------
    const reRun = await clonePlansToNextYear(tenant.ctx, owner.userId, {
      sourceYear: SOURCE_YEAR,
      targetYear: TARGET_YEAR,
      apply: true,
    });
    expect(reRun.skippedAlreadySeeded).toBe(true);
    expect(reRun.cloned).toHaveLength(0);

    // Still exactly 2 target rows (no double-insert).
    const targetRowsAfter = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select({ planId: membershipPlans.planId })
        .from(membershipPlans)
        .where(eq(membershipPlans.planYear, TARGET_YEAR)),
    );
    expect(targetRowsAfter).toHaveLength(2);

    // Audit count unchanged after idempotent re-run + skip emits nothing.
    await emitCloneAudits(tenant.ctx, owner.userId, reRun.cloned, TARGET_YEAR);
    const auditsAfter = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_created'),
            sql`(${auditLog.payload}->>'plan_year')::int = ${TARGET_YEAR}`,
          ),
        ),
    );
    expect(auditsAfter).toHaveLength(2);
  }, 60_000);
});
