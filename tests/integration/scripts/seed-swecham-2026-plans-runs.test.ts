/**
 * R3 Batch 4a (R3-C1) — seed script end-to-end smoke test.
 *
 * Round 3 review (R3-C1) flagged: `seed-swecham-2026-plans.ts:459,494`
 * pushed `description: { en: '' }` for every plan draft. Batch 3e
 * (`bf4d6d5c`) tightened `plan-repo.ts:rowToPlan` to call
 * `asLocaleText(row.description)`. `asLocaleText` rejects empty `en`
 * with `EmptyEnLocaleTextError`. Result: production seed CRASHES on
 * the first `planRepo.insert(...)` because the insert path returns
 * the row, which `rowToPlan` then hydrates → throw.
 *
 * The pre-existing `tests/integration/plans/seed-swecham-2026-fixture.test.ts`
 * only validated the `CORPORATE_SEED` + `PARTNERSHIP_SEED` constants —
 * NEVER ran the seed end-to-end. This file fills that gap.
 *
 * Strategy: drive `stageB_Plans` (exported in Batch 4a) against a
 * throwaway tenant + asserts:
 *   1. Returns `{ inserted: 9, skipped: false }` without throwing.
 *   2. All 9 rows persist with non-empty `description.en` (proves the
 *      Batch 4a description fallback works).
 *   3. `planRepo.findByTenantAndYear` succeeds — proves `rowToPlan`
 *      hydrates without throwing `EmptyEnLocaleTextError`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { asPlanYear } from '@/modules/plans/domain/plan';
import { stageB_Plans } from '@/../scripts/seed-swecham-2026-plans';
import { createTestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser } from '../helpers/test-users';

describe('Integration — seed-swecham-2026-plans end-to-end (R3-C1)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  it('R3-C1: stageB_Plans inserts all 9 plans without throwing EmptyEnLocaleTextError', async () => {
    const tenant = await createTestTenant('test-swecham');
    cleanups.push(tenant.cleanup);

    const owner = await createActiveTestUser();
    // R3 Batch 4b (R3-I1) — bound the cross-run users-table leak.
    // `audit_log` rows still survive (append-only trigger) but the
    // user row + sessions + tokens cascade-delete.
    cleanups.push(() => deleteTestUser(owner));

    // Drive the seed function. The pre-R3-C1 code crashed here on the
    // FIRST insert because rowToPlan(inserted[0]) → asLocaleText on
    // empty description → EmptyEnLocaleTextError throw.
    const status = await stageB_Plans(tenant.ctx, owner.userId);
    expect(status.skipped).toBe(false);
    expect(status.inserted).toBe(9); // 6 corporate + 3 partnership

    // Direct-DB verification: every inserted row has non-empty
    // description.en (proves the Batch 4a fallback worked).
    const rows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.tenantId, tenant.ctx.slug),
            eq(membershipPlans.planYear, 2026),
          ),
        ),
    );
    expect(rows.length).toBe(9);
    for (const row of rows) {
      const desc = row.description as Record<string, unknown> | null;
      expect(desc).not.toBeNull();
      expect(typeof desc?.en).toBe('string');
      expect((desc?.en as string).trim().length).toBeGreaterThan(0);
    }

    // Hydrate via planRepo.findByTenantAndYear — exercises the
    // canonical rowToPlan → asLocaleText path. Pre-R3-C1 this throws.
    const hydrated = await planRepo.findByTenantAndYear(tenant.ctx, {
      year: asPlanYear(2026),
      showDeleted: false,
    });
    expect(hydrated.length).toBe(9);
    for (const plan of hydrated) {
      expect(plan.description.en.trim().length).toBeGreaterThan(0);
      expect(plan.plan_name.en.trim().length).toBeGreaterThan(0);
    }
  }, 60_000);
});
