/**
 * I1 round-10 ui-design-specialist — integration test for the at-risk
 * quick-filter wiring in `searchDirectoryWithCount` (and by extension
 * the cursor-based `searchDirectory` path, which shares the same
 * filter condition shape).
 *
 * The agent's I1 recommendation surfaced the F8-fed
 * `risk_score_band` column as a directory filter chip — admins doing
 * renewal triage can scan only "at-risk" + "critical" members in one
 * click. This test pins the SQL-level filter behaviour:
 *
 *   1. No filter — every band + null-band member surfaces.
 *   2. `riskBand: 'at-risk'` — only band='at-risk' members surface.
 *   3. `riskBand: 'critical'` — only band='critical' surfaces.
 *   4. `riskBand: 'healthy'` — only band='healthy' surfaces.
 *   5. Null-band members (recompute hasn't run yet) are EXCLUDED when
 *      any band filter is active — the use-case port doc explicitly
 *      promises this behaviour ("members with `null` band are
 *      excluded from the filtered result").
 *
 * Live Neon Singapore + throwaway-tenant pattern same as the other
 * directory-search integration tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { directorySearchWithCount, createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
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

async function seedPlan(tenant: TestTenant, user: TestUser): Promise<string> {
  const planId = `risk-plan-${randomUUID().slice(0, 6)}`;
  await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Risk Band Plan' },
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
  return planId;
}

async function seedMember(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  companyName: string,
): Promise<string> {
  const deps = buildMembersDeps(tenant.ctx);
  const slug = `rb-${randomUUID().slice(0, 8)}`;
  const r = await createMember(
    {
      company_name: companyName,
      country: 'SE',
      plan_id: planId,
      plan_year: 2026,
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

/**
 * Direct UPDATE of `risk_score_band` so we can pin specific bands
 * without invoking the F8 batched-recompute use-case (which has its
 * own min-tenure / activity gates that would noise this test).
 * Score is set in lockstep so the column-level NOT-NULL invariant
 * (band IS NULL ⇔ score IS NULL) holds.
 */
async function setRiskBand(
  tenant: TestTenant,
  memberId: string,
  band: 'healthy' | 'warning' | 'at-risk' | 'critical',
  score: number,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx
      .update(members)
      .set({
        riskScore: score,
        riskScoreBand: band,
        riskScoreLastComputedAt: new Date(),
      })
      .where(eq(members.memberId, memberId));
  });
}

describe('directorySearchWithCount riskBand filter (I1 round-10)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  let healthy1: string;
  let warning1: string;
  let atRisk1: string;
  let atRisk2: string;
  let critical1: string;
  let nullBand1: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    planId = await seedPlan(tenant, user);

    healthy1 = await seedMember(tenant, user, planId, 'Healthy Co');
    warning1 = await seedMember(tenant, user, planId, 'Warning Co');
    atRisk1 = await seedMember(tenant, user, planId, 'AtRisk Co 1');
    atRisk2 = await seedMember(tenant, user, planId, 'AtRisk Co 2');
    critical1 = await seedMember(tenant, user, planId, 'Critical Co');
    nullBand1 = await seedMember(tenant, user, planId, 'NullBand Co');

    await setRiskBand(tenant, healthy1, 'healthy', 10);
    await setRiskBand(tenant, warning1, 'warning', 35);
    await setRiskBand(tenant, atRisk1, 'at-risk', 60);
    await setRiskBand(tenant, atRisk2, 'at-risk', 65);
    await setRiskBand(tenant, critical1, 'critical', 90);
    // nullBand1 left with NULL band — recompute "hasn't run yet"
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('no filter — returns all 6 seeded members (including null-band)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(6);
    // Sanity: every seeded id present in the result page.
    const ids = new Set(
      r.value.items.map((it) => it.member.memberId as string),
    );
    expect(ids.has(healthy1)).toBe(true);
    expect(ids.has(warning1)).toBe(true);
    expect(ids.has(atRisk1)).toBe(true);
    expect(ids.has(atRisk2)).toBe(true);
    expect(ids.has(critical1)).toBe(true);
    expect(ids.has(nullBand1)).toBe(true);
  });

  it('riskBand: at-risk — surfaces exactly the 2 at-risk members', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0, riskBand: 'at-risk' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(2);
    const ids = r.value.items.map((it) => it.member.memberId as string).sort();
    expect(ids).toEqual([atRisk1, atRisk2].sort());
  });

  it('riskBand: critical — surfaces exactly 1', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0, riskBand: 'critical' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(1);
    expect(r.value.items[0]?.member.memberId).toBe(critical1);
  });

  it('riskBand: healthy — surfaces exactly 1', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0, riskBand: 'healthy' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(1);
    expect(r.value.items[0]?.member.memberId).toBe(healthy1);
  });

  it('riskBand: [critical, at-risk, warning] — multi-band "needs attention" set (S1-P1-6)', async () => {
    // The dashboard at-risk KPI sums these three bands (countAtRisk); its
    // drill-down must return the SAME set so the count matches the destination
    // (previously the link filtered to 'at-risk' only, hiding critical+warning).
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0, riskBand: ['critical', 'at-risk', 'warning'] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(4); // warning1 + atRisk1 + atRisk2 + critical1
    const ids = new Set(r.value.items.map((it) => it.member.memberId as string));
    expect(ids.has(critical1)).toBe(true);
    expect(ids.has(atRisk1)).toBe(true);
    expect(ids.has(atRisk2)).toBe(true);
    expect(ids.has(warning1)).toBe(true);
    expect(ids.has(healthy1)).toBe(false); // healthy excluded
    expect(ids.has(nullBand1)).toBe(false); // null-band still excluded
  });

  it('riskBand filter — null-band members are excluded (port contract)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    // Sum across every band-specific filter should equal 5 (all
    // banded members), NOT 6 (which would mean the null-band member
    // leaked through under some filter).
    let summedTotal = 0;
    for (const band of ['healthy', 'warning', 'at-risk', 'critical'] as const) {
      const r = await directorySearchWithCount(
        { tenant: tenant.ctx, memberRepo: deps.memberRepo },
        { limit: 100, offset: 0, riskBand: band },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      summedTotal += r.value.total;
      // Confirm the null-band member never surfaces under any band filter.
      const ids = r.value.items.map((it) => it.member.memberId);
      expect(ids).not.toContain(nullBand1);
    }
    expect(summedTotal).toBe(5);
  });

  it('riskBand combines with q substring filter', async () => {
    // q "AtRisk" matches both AtRisk Co 1 + AtRisk Co 2. With
    // `riskBand: at-risk` we should still get both (both are flagged).
    // With `riskBand: healthy` AND q "AtRisk" — zero (no healthy
    // companies named "AtRisk").
    const deps = buildMembersDeps(tenant.ctx);
    const r1 = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0, riskBand: 'at-risk', q: 'AtRisk' },
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.total).toBe(2);

    const r2 = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0, riskBand: 'healthy', q: 'AtRisk' },
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.total).toBe(0);
  });

  it('sort=engagement desc — healthiest (lowest risk) first, null-band last (FR-007a)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0, sort: 'engagement', order: 'desc' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.items.map((it) => it.member.memberId as string);
    // eng desc = risk asc: 10,35,60,65,90 then null last.
    expect(ids).toEqual([healthy1, warning1, atRisk1, atRisk2, critical1, nullBand1]);
  });

  it('sort=engagement asc — least-engaged (highest risk) first, null-band still last', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0, sort: 'engagement', order: 'asc' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.items.map((it) => it.member.memberId as string);
    // eng asc = risk desc: 90,65,60,35,10 then null last.
    expect(ids).toEqual([critical1, atRisk2, atRisk1, warning1, healthy1, nullBand1]);
  });

  // Silence the unused-import warning for `inArray` — kept available
  // for follow-up assertions that may need a bulk-id IN list.
  void inArray;
});
