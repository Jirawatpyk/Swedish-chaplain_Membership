/**
 * Post-ship R6 I3 — Integration: concurrent `cloneYear` calls into the
 * same (tenant, targetYear) must serialise on the per-tenant advisory
 * lock so the second caller observes the first caller's committed
 * rows and aborts with `target_year_populated` instead of racing past
 * the `count > 0` check and tripping `membership_plans_pkey`.
 *
 * Two concurrent `Promise.all` callers: exactly ONE must return
 * `ok({count: N, clonedPlanIds: [...]})` and ONE must return
 * `err({type: 'target_year_populated', existingCount: N})`. Final
 * state in the target year is exactly N rows (no duplicates).
 *
 * Lock namespace: `plans:clone:<tenant-slug>:<targetYear>` (see
 * `plan-repo.ts` cloneYear preamble). Disjoint from F4 `invoicing:`
 * / F5 `payments:` / F7 `broadcasts:` / F8 `renewals:`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
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

function buildDrafts(userId: string, year: number, count: number): PlanDraftInput[] {
  return Array.from({ length: count }).map(
    (_, i) =>
      ({
        plan_id: `lock-src-${i}`,
        plan_year: year,
        plan_name: { en: `Lock Source ${i}` },
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

describe('Integration: cloneYear concurrent advisory lock (post-ship R6 I3)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) {
      await tenant.cleanup().catch(() => {});
    }
  });

  it('two concurrent cloneYear calls — exactly one succeeds, one returns target_year_populated', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Seed 5 source rows in year 2026
    for (const draft of buildDrafts(user.userId, 2026, 5)) {
      await planRepo.insert(tenant.ctx, draft);
    }

    // Fire two concurrent clones into year 2027
    const [resultA, resultB] = await Promise.all([
      planRepo.cloneYear(
        tenant.ctx,
        asPlanYear(2026),
        asPlanYear(2027),
        false,
        user.userId,
      ),
      planRepo.cloneYear(
        tenant.ctx,
        asPlanYear(2026),
        asPlanYear(2027),
        false,
        user.userId,
      ),
    ]);

    // Exactly one ok, one err
    const okCount = [resultA, resultB].filter((r) => r.ok).length;
    const errCount = [resultA, resultB].filter((r) => !r.ok).length;
    expect(okCount).toBe(1);
    expect(errCount).toBe(1);

    // The winner cloned 5 rows
    const winner = resultA.ok ? resultA : resultB;
    if (!winner.ok) throw new Error('expected one winner');
    expect(winner.value.count).toBe(5);
    expect(winner.value.clonedPlanIds).toHaveLength(5);

    // The loser hit target_year_populated with existingCount=5 (advisory
    // lock guaranteed the loser ran AFTER the winner committed)
    const loser = resultA.ok ? resultB : resultA;
    if (loser.ok) throw new Error('expected one loser');
    expect(loser.error.type).toBe('target_year_populated');
    if (loser.error.type === 'target_year_populated') {
      expect(loser.error.existingCount).toBe(5);
    }

    // Final state in target year is exactly 5 rows — no duplicates
    const finalRows = await planRepo.findByTenantAndYear(tenant.ctx, {
      year: asPlanYear(2027),
      showDeleted: true,
    });
    expect(finalRows).toHaveLength(5);
  });

  it('locks are disjoint per (tenant, targetYear) — different target years run in parallel without blocking', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Seed source rows in both 2025 and 2026 so each clone has its own source
    for (const draft of buildDrafts(user.userId, 2025, 3)) {
      await planRepo.insert(tenant.ctx, draft);
    }
    // Use different plan_ids for the 2026 source to avoid PK collision
    const drafts2026 = buildDrafts(user.userId, 2026, 3).map((d, i) => ({
      ...d,
      plan_id: `lock-src-2026-${i}`,
    }));
    for (const draft of drafts2026) {
      await planRepo.insert(tenant.ctx, draft);
    }

    // Clone 2025→2030 and 2026→2031 concurrently — different target
    // years acquire different lock keys so neither blocks the other
    const [r2030, r2031] = await Promise.all([
      planRepo.cloneYear(
        tenant.ctx,
        asPlanYear(2025),
        asPlanYear(2030),
        false,
        user.userId,
      ),
      planRepo.cloneYear(
        tenant.ctx,
        asPlanYear(2026),
        asPlanYear(2031),
        false,
        user.userId,
      ),
    ]);

    expect(r2030.ok).toBe(true);
    expect(r2031.ok).toBe(true);
    if (!r2030.ok || !r2031.ok) throw new Error('expected both ok');
    expect(r2030.value.count).toBe(3);
    expect(r2031.value.count).toBe(3);
  });
});
