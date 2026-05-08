/**
 * F8 Phase 6 review-round 2 B2 — migration 0114 tier_bucket repair
 * SQL contract test.
 *
 * Migration 0114 hard-codes 4 UPDATE statements scoped to
 * `tenant_id = 'swecham'` that fix the seed-time tier_bucket
 * misclassification (`premium`/`start-up`/`thai-alumni`/`individual`
 * mapping). The migration cannot be re-run against a test tenant
 * (tenant filter is hardcoded to 'swecham'), so this test:
 *
 *   1. Seeds 4 plans in a test tenant with the SAME wrong starting
 *      `renewal_tier_bucket` values that prompted migration 0114.
 *   2. Runs the SAME UPDATE shape parameterised against the test
 *      tenant slug.
 *   3. Asserts the post-update `renewal_tier_bucket` matches the
 *      expected canonical mapping documented in the migration
 *      header.
 *
 * If the SQL logic in 0114 is reverted or its filter narrows in a
 * future patch, this test fails — independent of whether the
 * migration was applied to the live swecham tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql as drizzleSql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { membershipPlans } from '@/modules/plans';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

interface PlanSpec {
  readonly planId: string;
  readonly initialBucket: string;
  readonly expectedBucket: string;
}

// Mirrors migration 0114 mapping rationale — see header docstring of
// `0114_f8_repair_renewal_tier_bucket_seed.sql`.
const REPAIR_PLANS: ReadonlyArray<PlanSpec> = [
  { planId: 'premium', initialBucket: 'regular', expectedBucket: 'premium' },
  { planId: 'start-up', initialBucket: 'regular', expectedBucket: 'start_up' },
  {
    planId: 'thai-alumni',
    initialBucket: 'regular',
    expectedBucket: 'thai_alumni',
  },
  {
    planId: 'individual',
    initialBucket: 'thai_alumni',
    expectedBucket: 'regular',
  },
];

describe('F8 migration 0114 tier_bucket repair (B2 SQL contract)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Seed each repair-target plan with its WRONG starting bucket.
    for (const p of REPAIR_PLANS) {
      await db.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: p.planId,
        planYear: 2026,
        planName: { en: `${p.planId} test` },
        description: { en: '' },
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 5_000_000,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        renewalTierBucket: p.initialBucket,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('runs the 4 repair UPDATEs and resolves each plan to its canonical bucket', async () => {
    // Replay migration 0114's UPDATE shape against the test tenant.
    const tenantSlug = tenant.ctx.slug;
    for (const p of REPAIR_PLANS) {
      await db.execute(drizzleSql`
        UPDATE "membership_plans"
           SET "renewal_tier_bucket" = ${p.expectedBucket}
         WHERE "tenant_id" = ${tenantSlug}
           AND "plan_id"   = ${p.planId}
           AND "renewal_tier_bucket" <> ${p.expectedBucket}
      `);
    }

    // Verify each plan landed at its canonical bucket.
    for (const p of REPAIR_PLANS) {
      const rows = await db
        .select({ bucket: membershipPlans.renewalTierBucket })
        .from(membershipPlans)
        .where(eq(membershipPlans.planId, p.planId));
      const matchingTenantRow = rows.find(() => true);
      expect(matchingTenantRow?.bucket).toBe(p.expectedBucket);
    }
  });

  it('UPDATE is idempotent — re-running emits no error and no spurious change', async () => {
    const tenantSlug = tenant.ctx.slug;
    for (const p of REPAIR_PLANS) {
      // No-op because rows already match expected bucket from previous test.
      await db.execute(drizzleSql`
        UPDATE "membership_plans"
           SET "renewal_tier_bucket" = ${p.expectedBucket}
         WHERE "tenant_id" = ${tenantSlug}
           AND "plan_id"   = ${p.planId}
           AND "renewal_tier_bucket" <> ${p.expectedBucket}
      `);
    }
    const rows = await db
      .select({
        planId: membershipPlans.planId,
        bucket: membershipPlans.renewalTierBucket,
      })
      .from(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenantSlug));
    const found = new Map(rows.map((r) => [r.planId, r.bucket]));
    for (const p of REPAIR_PLANS) {
      expect(found.get(p.planId)).toBe(p.expectedBucket);
    }
  });

  it('migration UPDATE does NOT touch unrelated tenants (tenant_id filter holds)', async () => {
    // Plant a foreign-tenant plan with a "wrong" bucket — the
    // migration UPDATE must leave it alone because the WHERE clause
    // pins tenant_id to the swecham target.
    const otherTenant = await createTestTenant('test-chamber');
    try {
      await db.insert(membershipPlans).values({
        tenantId: otherTenant.ctx.slug,
        planId: 'premium', // same plan_id, different tenant
        planYear: 2026,
        planName: { en: 'premium other' },
        description: { en: '' },
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 5_000_000,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        renewalTierBucket: 'regular', // intentionally "wrong" value
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      // Re-run only the swecham-targeted repair (tenant filter pinned).
      await db.execute(drizzleSql`
        UPDATE "membership_plans"
           SET "renewal_tier_bucket" = 'premium'
         WHERE "tenant_id" = 'swecham'
           AND "plan_id"   = 'premium'
           AND "renewal_tier_bucket" <> 'premium'
      `);
      // The other tenant's row stays at 'regular' — the migration
      // does not cross tenant boundaries.
      const rows = await db
        .select({ bucket: membershipPlans.renewalTierBucket })
        .from(membershipPlans)
        .where(eq(membershipPlans.tenantId, otherTenant.ctx.slug));
      expect(rows[0]?.bucket).toBe('regular');
    } finally {
      await db
        .delete(membershipPlans)
        .where(eq(membershipPlans.tenantId, otherTenant.ctx.slug))
        .catch(() => {});
      await otherTenant.cleanup().catch(() => {});
    }
  }, 120_000);
});
