/**
 * W0-02 completion (code-review #1) — `changePlan` must refuse to assign a
 * member to a soft-deleted plan, end-to-end against live Neon.
 *
 * This is the deterministic, non-vacuous regression lock the original
 * `soft-delete-toctou-advisory-lock.test.ts` lacked (code-review #7): it
 * exercises the REAL `plansBarrelAdapter.getPlan` (which now surfaces
 * `isSoftDeleted`) + the REAL `drizzlePlanAdvisoryLockAdapter` against a
 * plan whose `deleted_at IS NOT NULL`, and asserts the member FK is never
 * written. If the pre-tx guard AND the in-tx re-check were both removed, the
 * member would be assigned to the soft-deleted plan and this test would fail.
 *
 * Mirrors the seed harness in `change-plan-emits-both-audits.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import { changePlan, createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createActiveTestUser } from '../helpers/test-users';
import { createTwoTestTenants } from '../helpers/test-tenant';
import type { TestTenant } from '../helpers/test-tenant';
import type { TestUser } from '../helpers/test-users';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

const MATRIX: BenefitMatrix = {
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

async function seedPlan(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  planNameEn: string,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: planNameEn },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 500_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

describe('Integration — changePlan refuses a soft-deleted target plan (W0-02 #1)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) {
      try {
        await fn();
      } catch {
        // Best-effort
      }
    }
  });

  it(
    'assigning a member to a soft-deleted plan → plan_not_found, member FK unchanged',
    async () => {
      const pair = await createTwoTestTenants();
      cleanups.push(pair.a.cleanup, pair.b.cleanup);
      const tenant = pair.a;
      const user = await createActiveTestUser('admin');

      const currentPlanId = `sd-cur-${randomUUID().slice(0, 8)}`;
      const deletedPlanId = `sd-del-${randomUUID().slice(0, 8)}`;
      await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
      await seedPlan(tenant, user, currentPlanId, 'Current Plan');
      await seedPlan(tenant, user, deletedPlanId, 'To-Be-Deleted Plan');

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = `sd-${randomUUID().slice(0, 8)}`;
      const created = await createMember(
        {
          company_name: `SoftDel Co ${seedSlug}`,
          country: 'SE',
          plan_id: currentPlanId,
          plan_year: 2026,
          primary_contact: {
            first_name: 'Sven',
            last_name: 'SoftDel',
            email: `${seedSlug}@example.com`,
            preferred_language: 'en' as const,
          },
        },
        { actorUserId: user.userId, requestId: `sd-seed-${seedSlug}` },
        deps,
      );
      if (!created.ok)
        throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      // Soft-delete the TARGET plan directly (it has 0 members). This puts the
      // plan in exactly the state the guard must reject — `deleted_at NOT NULL`
      // while the row still exists (plans are soft-, never hard-deleted).
      await runInTenant(tenant.ctx, async (tx) => {
        await tx
          .update(membershipPlans)
          .set({ deletedAt: new Date(), updatedBy: user.userId })
          .where(
            and(
              eq(membershipPlans.planId, deletedPlanId),
              eq(membershipPlans.planYear, 2026),
            ),
          );
      });

      const r = await changePlan(
        memberId,
        { new_plan_id: deletedPlanId, new_plan_year: 2026 },
        { actorUserId: user.userId, requestId: `sd-change-${seedSlug}` },
        deps,
      );

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.type).toBe('plan_not_found');

      // The member must still be on the original plan — no FK write happened.
      const rows = await runInTenant(tenant.ctx, async (tx) =>
        tx
          .select({ planId: members.planId })
          .from(members)
          .where(eq(members.memberId, memberId))
          .limit(1),
      );
      expect(rows[0]?.planId).toBe(currentPlanId);
    },
    60_000,
  );
});
