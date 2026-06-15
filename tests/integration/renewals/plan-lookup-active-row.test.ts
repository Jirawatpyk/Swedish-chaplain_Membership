/**
 * F8 → F2 plan-lookup adapter · most-recent-ACTIVE-row regression
 * (Slice 3 production-readiness fix).
 *
 * `loadPlanFrozenFields` used to pick the MOST-RECENT `plan_year` row
 * for a `plan_id` (`ORDER BY plan_year DESC LIMIT 1`) and THEN check
 * `is_active`. Because `plan_id` is shared across `plan_year`s (the
 * `(tenant_id, plan_id, plan_year)` composite PK + "2025 + 2026
 * catalogue carry-over" pattern), a plan_id with an ACTIVE current-year
 * row (2026) AND a more-recent INACTIVE stray future-year row (the real
 * swecham catalogue carries inactive 2068 + 2028 rows) resolved to the
 * 2068 inactive row → `plan_inactive`, even though the active 2026 row
 * exists. That broke `createCycleInTx` (→ throws) for every affected
 * member across ALL renewal-creation paths (import cold-start, on-paid
 * steady-state, admin lapsed-comeback) AND the confirm-renewal
 * plan-change path.
 *
 * The fix is a two-step active-first lookup:
 *   1. Most-recent ACTIVE row (`is_active = true ORDER BY plan_year DESC`)
 *      → `found`.
 *   2. If no active row, a second probe for ANY non-deleted row → if one
 *      exists return `plan_inactive`, else `not_found`. This preserves
 *      the `plan_inactive` vs `not_found` distinction that
 *      `confirm-renewal` maps to two different member-facing errors.
 *
 * Live Neon — proves the real `ORDER BY plan_year DESC` + `is_active`
 * behaviour against the actual `membership_plans` schema, not a mock.
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

describe('F8 plan-lookup adapter — most-recent-ACTIVE-row (slice 3)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  // plan_id with an ACTIVE 2026 row + a more-recent INACTIVE 2068 stray.
  let strayRowPlanId: string;
  // plan_id with ONLY inactive rows.
  let allInactivePlanId: string;
  // plan_id with a single active row (regression — the simple case).
  let singleActivePlanId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    strayRowPlanId = `f8-stray-${randomUUID().slice(0, 8)}`;
    allInactivePlanId = `f8-inactive-${randomUUID().slice(0, 8)}`;
    singleActivePlanId = `f8-single-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      // ── Stray-row scenario ───────────────────────────────────────
      // ACTIVE current-year row @ 50,000.00 THB (price under test).
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: strayRowPlanId,
        planYear: 2026,
        planName: { en: 'Stray-Row Active 2026' },
        annualFeeMinorUnits: 5_000_000, // 50,000.00 THB
        renewalTierBucket: 'regular',
        isActive: true,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      // More-recent INACTIVE stray future-year row (the real swecham
      // 2068/2028 carry-over). DESC plan_year would pick THIS row.
      // Different price so a wrong pick is unambiguous.
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: strayRowPlanId,
        planYear: 2068,
        planName: { en: 'Stray-Row Inactive 2068' },
        annualFeeMinorUnits: 9_900_000, // 99,000.00 THB
        renewalTierBucket: 'premium',
        isActive: false,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });

      // ── All-inactive scenario ────────────────────────────────────
      // Two inactive rows, no active row anywhere for this plan_id.
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: allInactivePlanId,
        planYear: 2026,
        planName: { en: 'All-Inactive 2026' },
        isActive: false,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: allInactivePlanId,
        planYear: 2028,
        planName: { en: 'All-Inactive 2028' },
        isActive: false,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });

      // ── Single-active scenario (regression) ──────────────────────
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: singleActivePlanId,
        planYear: 2026,
        planName: { en: 'Single Active 2026' },
        annualFeeMinorUnits: 18_000_000, // 180,000.00 THB
        renewalTierBucket: 'premium',
        isActive: true,
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

  // 070 — these tests exercise the EXACT-YEAR-MISS fallback path (the
  // pre-070 "most-recent ACTIVE row by plan_year DESC" behaviour, which is
  // preserved UNCHANGED when no row exists for the requested fiscal year).
  // Each call passes `fiscalYear: 2099` (no seeded row at that year) so
  // Step-1 misses and Step-2 fallback runs — the exact behaviour these
  // assertions lock. The new exact-year-FIRST resolution is covered by
  // `plan-lookup-by-fiscal-year.test.ts`.
  const FALLBACK_FISCAL_YEAR = 2099;

  it('stray inactive future-year row: returns the ACTIVE 2026 price, NOT plan_inactive', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: strayRowPlanId,
      fiscalYear: FALLBACK_FISCAL_YEAR,
      mode: 'freeze',
    });

    // Before the fix DESC picks the 2068 inactive row → plan_inactive.
    // After the fix the active-first fallback returns the 2026 row.
    expect(result.status).toBe('found');
    if (result.status !== 'found') return; // narrow for TS
    expect(result.plan).toEqual({
      tierBucket: 'regular',
      priceTHB: '50000.00',
      termMonths: 12,
      currency: 'THB',
    });
  });

  it('only-inactive rows: returns plan_inactive (distinction preserved)', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: allInactivePlanId,
      fiscalYear: FALLBACK_FISCAL_YEAR,
      mode: 'freeze',
    });
    expect(result.status).toBe('plan_inactive');
  });

  it('nonexistent plan_id: returns not_found (distinction preserved)', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: `f8-missing-${randomUUID().slice(0, 8)}`,
      fiscalYear: FALLBACK_FISCAL_YEAR,
      mode: 'freeze',
    });
    expect(result.status).toBe('not_found');
  });

  it('single active row: returns found (regression — simple case unbroken)', async () => {
    const adapter = makeDrizzlePlanLookupForRenewal(tenant.ctx);
    const result = await adapter.loadPlanFrozenFields({
      tenantId: tenant.ctx.slug,
      planId: singleActivePlanId,
      fiscalYear: FALLBACK_FISCAL_YEAR,
      mode: 'freeze',
    });
    expect(result.status).toBe('found');
    if (result.status !== 'found') return; // narrow for TS
    expect(result.plan).toEqual({
      tierBucket: 'premium',
      priceTHB: '180000.00',
      termMonths: 12,
      currency: 'THB',
    });
  });
});
