/**
 * 070-f8-followups — §86/4 tax-review advisory (commit 40874e39).
 *
 * `planLookupAdapter.getAnnualFeeSatang` resolves the annual fee +
 * validates the `(tenant_id, plan_id, plan_year)` catalogue row at
 * INVOICE time. The F8 frozen-plan adapter
 * (`plan-lookup-for-renewal-drizzle.ts`) filters `deleted_at IS NULL`;
 * this F4 adapter did NOT — an asymmetry where a SOFT-DELETED catalogue
 * row still satisfied the fee/FK check at invoice time even though the
 * frozen-plan adapter rejects it. A §86/4 must not be billable against
 * a soft-deleted plan-year row.
 *
 * Fix: add `AND deleted_at IS NULL` to the `getAnnualFeeSatang` query.
 *
 * Two cases prove the filter is exactly right (excludes deleted, keeps
 * inactive-not-deleted):
 *   1. SOFT-DELETED row (`deleted_at = now()`)  → returns null.
 *   2. INACTIVE row (`is_active = false`, `deleted_at IS NULL`) → still
 *      returns the fee — an `is_active` filter is INTENTIONALLY absent
 *      (a seeded-but-INACTIVE next-year row must validate for the FK +
 *      fee when a next-year cycle bills; inactive ≠ deleted).
 *
 * Live Neon Singapore via .env.local.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { planLookupAdapter } from '@/modules/invoicing/infrastructure/adapters/plan-lookup-adapter';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const PLAN_YEAR = 2026;
const FEE_MINOR_UNITS = 4_200_000; // 42,000.00 THB

describe('planLookupAdapter.getAnnualFeeSatang — soft-delete exclusion (070 §86/4 advisory)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let softDeletedPlanId: string;
  let inactivePlanId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();

    softDeletedPlanId = `f4-softdel-${randomUUID().slice(0, 8)}`;
    inactivePlanId = `f4-inactive-${randomUUID().slice(0, 8)}`;

    // Case 1 — seed an active plan, then SOFT-DELETE it.
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: softDeletedPlanId,
        planName: { en: 'Soft-deleted Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        planYear: PLAN_YEAR,
        annualFeeMinorUnits: FEE_MINOR_UNITS,
        isActive: true,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({ deletedAt: new Date() })
        .where(eq(membershipPlans.planId, softDeletedPlanId)),
    );

    // Case 2 — seed an INACTIVE plan (is_active=false, deleted_at NULL).
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: inactivePlanId,
        planName: { en: 'Inactive (not deleted) Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        planYear: PLAN_YEAR,
        annualFeeMinorUnits: FEE_MINOR_UNITS,
        isActive: false,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('returns null for a SOFT-DELETED plan row (cannot bill a §86/4 against a deleted plan)', async () => {
    const fee = await planLookupAdapter.getAnnualFeeSatang(
      tenant.ctx.slug,
      softDeletedPlanId,
      PLAN_YEAR,
    );
    expect(fee).toBeNull();
  }, 120_000);

  it('STILL returns the fee for an INACTIVE (not-deleted) plan row (FK + fee validation for a next-year cycle)', async () => {
    const fee = await planLookupAdapter.getAnnualFeeSatang(
      tenant.ctx.slug,
      inactivePlanId,
      PLAN_YEAR,
    );
    expect(fee).toBe(BigInt(FEE_MINOR_UNITS));
  }, 120_000);
});
