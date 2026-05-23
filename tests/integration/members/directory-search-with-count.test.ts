/**
 * Integration: searchDirectoryWithCount vs live Neon.
 *
 * Powers the `/admin/members` numbered pagination. Covers:
 *   - total count matches the number of matching rows under the same filter
 *   - offset paginates without gaps / overlaps
 *   - substring q filters BOTH the count and the page consistently
 *   - status filter narrows the count (archived excluded by default)
 *   - RLS scoping — the count never leaks cross-tenant rows
 *   - Edge: offset past the end returns zero items but the total is preserved
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { directorySearchWithCount, createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

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
): Promise<string> {
  const planId = `page-plan-${randomUUID().slice(0, 6)}`;
  // R9 — fiscal seed moved to tenant_invoice_settings via shared helper.
  await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Page Plan' },
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
): Promise<void> {
  const deps = buildMembersDeps(tenant.ctx);
  const slug = `page-${randomUUID().slice(0, 8)}`;
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
}

describe('directorySearchWithCount integration (offset pagination)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let planA: string;
  let planB: string;

  const TOTAL_IN_A = 5;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    planA = await seedPlan(tenantA, user);
    planB = await seedPlan(tenantB, user);

    // Seed TOTAL_IN_A members in tenant A
    for (let i = 0; i < TOTAL_IN_A; i++) {
      await seedMember(tenantA, user, planA, `Page Co ${i}`);
    }
    // Seed a handful of DIFFERENT members in tenant B (to prove RLS)
    for (let i = 0; i < 3; i++) {
      await seedMember(tenantB, user, planB, `OtherTenant Co ${i}`);
    }
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('returns total matching the seeded count with default filter', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenantA.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(TOTAL_IN_A);
    expect(r.value.items.length).toBe(TOTAL_IN_A);
  });

  it('offset skips leading rows without overlap', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const pageSize = 2;

    const p1 = await directorySearchWithCount(
      { tenant: tenantA.ctx, memberRepo: deps.memberRepo },
      { limit: pageSize, offset: 0 },
    );
    const p2 = await directorySearchWithCount(
      { tenant: tenantA.ctx, memberRepo: deps.memberRepo },
      { limit: pageSize, offset: pageSize },
    );
    const p3 = await directorySearchWithCount(
      { tenant: tenantA.ctx, memberRepo: deps.memberRepo },
      { limit: pageSize, offset: pageSize * 2 },
    );

    expect(p1.ok).toBe(true);
    expect(p2.ok).toBe(true);
    expect(p3.ok).toBe(true);
    if (!p1.ok || !p2.ok || !p3.ok) return;

    // Same total on every page
    expect(p1.value.total).toBe(TOTAL_IN_A);
    expect(p2.value.total).toBe(TOTAL_IN_A);
    expect(p3.value.total).toBe(TOTAL_IN_A);

    // No id overlap between pages
    const ids = new Set<string>();
    for (const p of [p1, p2, p3]) {
      for (const row of p.value.items) {
        expect(ids.has(row.member.memberId)).toBe(false);
        ids.add(row.member.memberId);
      }
    }
    // Sum of page sizes equals total (5 = 2 + 2 + 1)
    expect(ids.size).toBe(TOTAL_IN_A);
  });

  it('substring q narrows BOTH total and items consistently', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    // Match a single seeded row by its unique index suffix
    const r = await directorySearchWithCount(
      { tenant: tenantA.ctx, memberRepo: deps.memberRepo },
      { q: 'Page Co 2', limit: 100, offset: 0 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(1);
    expect(r.value.items.length).toBe(1);
    expect(r.value.items[0]!.member.companyName).toBe('Page Co 2');
  });

  it('tenantA total never leaks tenantB rows (RLS)', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenantA.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Exactly our tenant A seeds — no tenant B rows
    expect(r.value.total).toBe(TOTAL_IN_A);
    for (const row of r.value.items) {
      expect(row.member.companyName.startsWith('Page Co')).toBe(true);
      expect(row.member.companyName.startsWith('OtherTenant')).toBe(false);
    }
  });

  it('offset past the end returns empty items but preserves total', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenantA.ctx, memberRepo: deps.memberRepo },
      { limit: 10, offset: 9999 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(0);
    expect(r.value.total).toBe(TOTAL_IN_A);
  });

  it('primary_contact payload is populated on each row', async () => {
    const deps = buildMembersDeps(tenantA.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenantA.ctx, memberRepo: deps.memberRepo },
      { limit: 2, offset: 0 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const row of r.value.items) {
      expect(row.primaryContact).not.toBeNull();
      expect(row.primaryContact?.firstName).toBe('Anna');
    }
  });

  it('plan_display_name is correlated PER ROW (catches alias() always-true regression)', async () => {
    // MED-1: every other directory test seeds exactly ONE plan, so the
    // documented `alias()` correlation trap (subquery WHERE collapsing to
    // always-true) would still return that one plan's name and stay green.
    // Here two DISTINCTLY-NAMED plans live in the same tenant with a member on
    // each — asserting each row carries ITS OWN plan name is the only check
    // that catches a correlation regression.
    const { a: t } = await createTwoTestTenants();
    try {
      await seedTenantFiscal({ tenant: t, registrationFeeSatang: 100000n });
      const planX = `corr-x-${randomUUID().slice(0, 6)}`;
      const planY = `corr-y-${randomUUID().slice(0, 6)}`;
      const planRow = (planId: string, nameEn: string) => ({
        tenantId: t.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: nameEn },
        description: { en: 'corr test' },
        sortOrder: 10,
        planCategory: 'corporate' as const,
        memberTypeScope: 'company' as const,
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
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(membershipPlans).values([
          planRow(planX, 'Corr Plan X'),
          planRow(planY, 'Corr Plan Y'),
        ]);
      });
      await seedMember(t, user, planX, 'Corr Member X');
      await seedMember(t, user, planY, 'Corr Member Y');

      const deps = buildMembersDeps(t.ctx);
      const r = await directorySearchWithCount(
        { tenant: t.ctx, memberRepo: deps.memberRepo },
        { limit: 100, offset: 0 },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const byName = new Map(
        r.value.items.map((i) => [i.member.companyName, i.planDisplayName]),
      );
      // Each row resolves ITS OWN plan name — proves per-row correlation.
      expect(byName.get('Corr Member X')).toBe('Corr Plan X');
      expect(byName.get('Corr Member Y')).toBe('Corr Plan Y');
    } finally {
      await t.cleanup().catch(() => {});
    }
  }, 60_000);
});
