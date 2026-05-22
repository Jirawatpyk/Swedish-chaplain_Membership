/**
 * T094 — Integration: clone-plans-to-year idempotency (US2).
 *
 * Scenarios:
 *   1. Fresh clone 2026→2027 — 9 new rows inserted, target year populated
 *   2. Second clone 2026→2027 (target now populated) — returns
 *      `target_year_populated` without mutating existing rows
 *   3. Delete the 9 cloned 2027 rows, then clone again — succeeds
 *   4. Source year has zero plans — returns `source_year_empty`
 *   5. activate_cloned=false (default) → new rows land is_active=false
 *   6. activate_cloned=true → new rows land is_active=true
 *
 * Uses UUID-suffixed test tenants so parallel CI runs can't collide.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { db } from '@/lib/db';
import { asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanDraftInput } from '@/modules/plans/application/ports';
import { createActiveTestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 0,
  website_page_type: null,
  homepage_logo_category: null,
  directory_listing_size: null,
  event_discount_scope: 'none',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: false,
  business_referrals: false,
  tailor_made_services: false,
  partnership: null,
};

function buildDrafts(
  userId: string,
  year: number,
  count: number,
): PlanDraftInput[] {
  return Array.from({ length: count }).map(
    (_, i) =>
      ({
        plan_id: `clone-src-${i}`,
        plan_year: year,
        plan_name: { en: `Source ${i}` },
        description: { en: 'Test description' },
        sort_order: i * 10,
        plan_category: 'corporate',
        member_type_scope: 'company',
        annual_fee_minor_units: 100_000 * (i + 1),
        includes_corporate_plan_id: null,
        min_turnover_minor_units: null,
        max_turnover_minor_units: null,
        max_duration_years: null,
        max_member_age: null,
        benefit_matrix: MATRIX,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      }) as PlanDraftInput,
  );
}

describe('Integration: clone-plans idempotency (T094)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) {
      await tenant.cleanup().catch(() => {});
    }
  });

  it('Scenario 1 — fresh clone 2026→2027 inserts 9 inactive rows', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    for (const draft of buildDrafts(user.userId, 2026, 9)) {
      await planRepo.insert(tenant.ctx, draft);
    }

    const result = await planRepo.cloneYear(
      tenant.ctx,
      asPlanYear(2026),
      asPlanYear(2027),
      false, // activate_cloned = false
      user.userId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.count).toBe(9);
    expect(result.value.clonedPlanIds).toHaveLength(9);

    const cloned = await planRepo.findByTenantAndYear(tenant.ctx, {
      year: asPlanYear(2027),
      showDeleted: true,
    });
    expect(cloned).toHaveLength(9);
    for (const p of cloned) {
      expect(p.is_active).toBe(false);
    }
  });

  it('Scenario 2 — second clone with target_year populated returns error', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    for (const draft of buildDrafts(user.userId, 2026, 9)) {
      await planRepo.insert(tenant.ctx, draft);
    }

    const first = await planRepo.cloneYear(
      tenant.ctx,
      asPlanYear(2026),
      asPlanYear(2027),
      false,
      user.userId,
    );
    expect(first.ok).toBe(true);

    const second = await planRepo.cloneYear(
      tenant.ctx,
      asPlanYear(2026),
      asPlanYear(2027),
      false,
      user.userId,
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected err');
    expect(second.error.type).toBe('target_year_populated');
  });

  it('Scenario 3 — delete target then re-clone succeeds', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    for (const draft of buildDrafts(user.userId, 2026, 9)) {
      await planRepo.insert(tenant.ctx, draft);
    }

    await planRepo.cloneYear(
      tenant.ctx,
      asPlanYear(2026),
      asPlanYear(2027),
      false,
      user.userId,
    );

    // Hard-delete target-year rows through the BYPASS RLS admin client
    // (test-only path — emulates what the cleanup helper would do).
    await db.delete(membershipPlans).where(eq(membershipPlans.planYear, 2027));

    const second = await planRepo.cloneYear(
      tenant.ctx,
      asPlanYear(2026),
      asPlanYear(2027),
      false,
      user.userId,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok');
    expect(second.value.count).toBe(9);
  });

  it('Scenario 4 — source_year_empty when source has zero plans', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    const result = await planRepo.cloneYear(
      tenant.ctx,
      asPlanYear(2030),
      asPlanYear(2031),
      false,
      user.userId,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.type).toBe('source_year_empty');
  });

  it('Scenario 5 — activate_cloned=true lands rows active', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    for (const draft of buildDrafts(user.userId, 2026, 3)) {
      await planRepo.insert(tenant.ctx, draft);
    }

    const result = await planRepo.cloneYear(
      tenant.ctx,
      asPlanYear(2026),
      asPlanYear(2027),
      true, // activate_cloned = true
      user.userId,
    );
    expect(result.ok).toBe(true);
    const cloned = await planRepo.findByTenantAndYear(tenant.ctx, {
      year: asPlanYear(2027),
      showDeleted: true,
    });
    for (const p of cloned) {
      expect(p.is_active).toBe(true);
    }
  });
});
