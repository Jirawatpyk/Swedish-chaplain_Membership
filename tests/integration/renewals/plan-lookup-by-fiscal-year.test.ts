/**
 * F8 → F2 plan-lookup adapter · cycle-fiscal-year resolution (070).
 *
 * Regression guard for the latent multi-active-year §86/4 footgun:
 * `loadPlanFrozenFields` used to resolve a plan by "most-recent ACTIVE
 * row ordered by plan_year DESC", ignoring the cycle's fiscal year. If a
 * future-year catalogue row is activated (a reasonable admin pre-opening
 * action), a CURRENT-period cycle's frozen price would silently resolve
 * to the FUTURE-year row → wrong tax amount, no error.
 *
 * The fix makes resolution exact-year-FIRST: the caller threads the
 * relevant cycle's fiscal year + a `requireActiveForYear` flag.
 *
 * Live Neon — proves the real composite-PK exact-year SELECT + the
 * `is_active`/`requireActiveForYear` branch + the exact-year-MISS
 * fallback against the actual `membership_plans` schema, not a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { makeDrizzlePlanLookupForRenewal } from '@/modules/renewals/infrastructure/ports-adapters/plan-lookup-for-renewal-drizzle';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('F8 plan-lookup adapter — cycle fiscal-year resolution (070)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  // plan_id carrying an ACTIVE 2026 row AND an ACTIVE 2027 row —
  // the multi-active-year scenario the bug ignored.
  let bothActivePlanId: string;
  // plan_id carrying an ACTIVE 2026 row AND an INACTIVE 2027 row (the
  // common "next-year catalogue seeded-but-not-yet-active" case).
  let inactiveNextYearPlanId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    bothActivePlanId = `f8-both-${randomUUID().slice(0, 8)}`;
    inactiveNextYearPlanId = `f8-nextyr-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      // ── Both-years-active scenario ───────────────────────────────
      // ACTIVE 2026 @ 50,000.00 THB (regular).
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: bothActivePlanId,
        planYear: 2026,
        planName: { en: 'Both-Active 2026' },
        annualFeeMinorUnits: 5_000_000, // 50,000.00 THB
        renewalTierBucket: 'regular',
        isActive: true,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      // ACTIVE 2027 @ 60,000.00 THB (premium). DESC plan_year would pick
      // THIS row under the old "most-recent active" logic — the bug.
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: bothActivePlanId,
        planYear: 2027,
        planName: { en: 'Both-Active 2027' },
        annualFeeMinorUnits: 6_000_000, // 60,000.00 THB
        renewalTierBucket: 'premium',
        isActive: true,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });

      // ── Inactive-next-year scenario ──────────────────────────────
      // ACTIVE 2026 @ 70,000.00 THB.
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: inactiveNextYearPlanId,
        planYear: 2026,
        planName: { en: 'NextYr Active 2026' },
        annualFeeMinorUnits: 7_000_000, // 70,000.00 THB
        renewalTierBucket: 'regular',
        isActive: true,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      // INACTIVE 2027 @ 80,000.00 THB — seeded-but-not-yet-active next
      // year. For a 2027 cycle FREEZE this IS the correct frozen price.
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: inactiveNextYearPlanId,
        planYear: 2027,
        planName: { en: 'NextYr Inactive 2027' },
        annualFeeMinorUnits: 8_000_000, // 80,000.00 THB
        renewalTierBucket: 'premium',
        isActive: false,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
    });
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('both years active: fiscalYear 2026 resolves the 2026 row (NOT the more-recent active 2027) — the §86/4 regression guard', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: bothActivePlanId,
      fiscalYear: 2026,
      requireActiveForYear: false,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') return; // narrow for TS
    expect(result.plan).toEqual({
      tierBucket: 'regular',
      priceTHB: '50000.00',
      termMonths: 12,
      currency: 'THB',
    });
  });

  it('both years active: fiscalYear 2027 resolves the 2027 row', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: bothActivePlanId,
      fiscalYear: 2027,
      requireActiveForYear: false,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') return; // narrow for TS
    expect(result.plan).toEqual({
      tierBucket: 'premium',
      priceTHB: '60000.00',
      termMonths: 12,
      currency: 'THB',
    });
  });

  it('FREEZE (requireActiveForYear:false): a seeded-INACTIVE 2027 row IS the correct 2027 frozen price', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: inactiveNextYearPlanId,
      fiscalYear: 2027,
      requireActiveForYear: false,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') return; // narrow for TS
    expect(result.plan.priceTHB).toBe('80000.00');
    expect(result.plan.tierBucket).toBe('premium');
  });

  it('PLAN-CHANGE (requireActiveForYear:true): the INACTIVE 2027 row → plan_inactive (cannot switch to a plan not offered that year; NO fall-through to 2026)', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: inactiveNextYearPlanId,
      fiscalYear: 2027,
      requireActiveForYear: true,
    });
    expect(result.status).toBe('plan_inactive');
  });

  it('exact-year MISS (fiscalYear 2099, no row): falls back to most-recent ACTIVE row (unchanged behaviour)', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: bothActivePlanId,
      fiscalYear: 2099,
      requireActiveForYear: false,
    });
    // No 2099 row → fallback picks the most-recent ACTIVE (2027 @ 60k).
    expect(result.status).toBe('found');
    if (result.status !== 'found') return; // narrow for TS
    expect(result.plan.priceTHB).toBe('60000.00');
  });

  it('nonexistent plan_id: returns not_found (distinction preserved)', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: `f8-missing-${randomUUID().slice(0, 8)}`,
      fiscalYear: 2026,
      requireActiveForYear: false,
    });
    expect(result.status).toBe('not_found');
  });
});
