/**
 * COMP-1 (Member Erasure) — H4 follow-up: an ERASED member's anonymised
 * tombstone row MUST NOT be counted by the FR-010 plan-soft-delete guard.
 *
 * `eraseMember` deliberately KEEPS `status` (active/inactive — erasure is
 * orthogonal to archive) and `plan_id`/`plan_year`, stamping only the new
 * `erased_at` column. The F2 FR-010 guard ("a plan with active/inactive
 * members cannot be soft-deleted; members must be moved first") counts
 * members by STATUS — so without an explicit `erased_at IS NULL` an erased,
 * anonymised, effectively-gone member would still BLOCK a plan from being
 * soft-deleted and still inflate the bundle-change warning dialog count.
 *
 * The H4 sweep added `erased_at IS NULL` to the members-module operational
 * reads but missed these three FR-010 COUNT sites:
 *   - `countActiveMembersOnPlan`        (F2 MemberAttachmentChecker round-trip)
 *   - `countActiveMembersOnPlanInTx`    (plan-repo `softDeleteGuarded`, in-tx)
 *   - `countAffectedMembers`            (bundle-change warning, via
 *                                        `affectedMembersCount` use case)
 *
 * This suite proves all three return 0 once the only remaining member on a
 * plan is erased — i.e. the plan can now be soft-deleted.
 *
 * Live Neon. Reuses the directory-search seed pattern (createMember + a seeded
 * plan) and erases via the PRODUCTION composition root `buildEraseMemberDeps`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  affectedMembersCount,
  countActiveMembersOnPlan,
  countActiveMembersOnPlanInTx,
  createMember,
  eraseMember,
  type MemberId,
  type PlanId as MemberPlanId,
} from '@/modules/members';
import {
  buildMembersDeps,
  buildEraseMemberDeps,
} from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

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

const PLAN_YEAR = 2026;

async function seedPlan(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
): Promise<void> {
  await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: PLAN_YEAR,
      planName: { en: 'Erased Plan-Count Plan' },
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

async function seedMember(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  companyName: string,
): Promise<MemberId> {
  const deps = buildMembersDeps(tenant.ctx);
  const slug = `erased-count-${randomUUID().slice(0, 8)}`;
  const r = await createMember(
    {
      company_name: companyName,
      country: 'SE',
      plan_id: planId,
      plan_year: PLAN_YEAR,
      primary_contact: {
        first_name: 'Anna',
        last_name: 'Andersson',
        email: `${slug}@example.com`,
        preferred_language: 'sv' as const,
      },
    },
    { actorUserId: user.userId, requestId: `seed-${slug}` },
    deps,
  );
  if (!r.ok) {
    throw new Error(`seed ${companyName} failed: ${JSON.stringify(r.error)}`);
  }
  return r.value.memberId;
}

describe('erased members excluded from FR-010 plan-soft-delete counts', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let keptId: MemberId;
  let erasedId: MemberId;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `erased-count-plan-${randomUUID().slice(0, 6)}`;
    await seedPlan(tenant, user, planId);

    // Two members on the SAME plan. One stays active; one is erased.
    keptId = await seedMember(
      tenant,
      user,
      planId,
      `ErasedCountKept-${randomUUID().slice(0, 8)}`,
    );
    erasedId = await seedMember(
      tenant,
      user,
      planId,
      `ErasedCountGone-${randomUUID().slice(0, 8)}`,
    );

    const eraseDeps = buildEraseMemberDeps(tenant.ctx);
    const res = await eraseMember(
      erasedId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: user.userId, requestId: 'erased-count-seed' },
      eraseDeps,
    );
    if (!res.ok) {
      throw new Error(`erase seed failed: ${JSON.stringify(res.error)}`);
    }
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  // Sanity: the kept (active) member IS still counted — proves the filter is
  // scoped to erased tombstones, not silently zeroing every count.
  it('countActiveMembersOnPlan counts the kept member but not the erased one', async () => {
    const n = await countActiveMembersOnPlan(tenant.ctx, planId, PLAN_YEAR);
    // Dedicated tenant + dedicated plan: exactly the one non-erased member.
    expect(n).toBe(1);
  });

  it('countActiveMembersOnPlanInTx (softDeleteGuarded path) excludes the erased member', async () => {
    const n = await runInTenant(tenant.ctx, (tx) =>
      countActiveMembersOnPlanInTx(tx, planId, PLAN_YEAR),
    );
    expect(n).toBe(1);
  });

  it('countAffectedMembers (bundle-change warning) excludes the erased member', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await affectedMembersCount(
      { planId: planId as MemberPlanId, planYear: PLAN_YEAR },
      { tenant: tenant.ctx, plans: deps.plans },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.count).toBe(1);
  });

  // The load-bearing assertion: erase the ONLY remaining member and the
  // FR-010 guard count drops to 0 → the plan becomes soft-deletable.
  it('after erasing the last remaining member the plan-count is 0 (plan soft-deletable)', async () => {
    const eraseDeps = buildEraseMemberDeps(tenant.ctx);
    const res = await eraseMember(
      keptId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: user.userId, requestId: 'erased-count-last' },
      eraseDeps,
    );
    expect(res.ok).toBe(true);

    const viaSimple = await countActiveMembersOnPlan(tenant.ctx, planId, PLAN_YEAR);
    expect(viaSimple).toBe(0);

    const viaTx = await runInTenant(tenant.ctx, (tx) =>
      countActiveMembersOnPlanInTx(tx, planId, PLAN_YEAR),
    );
    expect(viaTx).toBe(0);

    const deps = buildMembersDeps(tenant.ctx);
    const r = await affectedMembersCount(
      { planId: planId as MemberPlanId, planYear: PLAN_YEAR },
      { tenant: tenant.ctx, plans: deps.plans },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.count).toBe(0);
  }, 60_000);
});
