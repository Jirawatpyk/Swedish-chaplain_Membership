/**
 * #765 — the tier-upgrade admin queue pages through EVERY suggestion and the
 * tab count is the true count.
 *
 * Before #765 the repo ignored `cursor` (`void args`) and the page read 50
 * rows, so a 51st suggestion was silently unreachable and the Renewals tab
 * badge (`items.length`) stopped at 50.
 *
 * 55 open suggestions are seeded with `created_at` values a few MICROseconds
 * apart, several inside one millisecond, so a cursor that went through a JS
 * Date (milliseconds) would repeat or skip rows at the page boundary. Live
 * Neon: the keyset compare and `to_char` precision only show against real
 * Postgres.
 *
 * Principle I: a second tenant's walk and count never see tenant A's rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

async function seedPlans(tenant: TestTenant, user: TestUser): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    for (const planId of ['regular', 'premium']) {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: planId },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 5_000_000,
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
    }
  });
}

/** `n` open suggestions, one member each, `created_at` 3µs apart (several per millisecond). */
async function seedSuggestions(tenant: TestTenant, n: number): Promise<string[]> {
  const ids: string[] = [];
  await runInTenant(tenant.ctx, async (tx) => {
    for (let i = 0; i < n; i++) {
      const memberId = randomUUID();
      const suggestionId = randomUUID();
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Queue Paging Co ${i}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        turnoverThb: 120_000_000,
      });
      await tx.insert(tierUpgradeSuggestions).values({
        tenantId: tenant.ctx.slug,
        suggestionId,
        memberId,
        fromPlanId: 'regular',
        toPlanId: 'premium',
        reasonCode: 'declared_turnover_above_threshold',
        evidenceJsonb: {
          reasonCode: 'declared_turnover_above_threshold',
          turnoverThb: 120_000_000,
          thresholdMetAt: '2026-11-01T00:00:00.000Z',
        },
        status: 'open',
        createdAt: sql`TIMESTAMPTZ '2026-11-01 03:00:00.000000+00' + (${i * 3} * INTERVAL '1 microsecond')` as never,
      });
      ids.push(suggestionId);
    }
  });
  return ids;
}

async function clear(tenant: TestTenant): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.delete(tierUpgradeSuggestions).where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)).catch(() => {});
    await tx.delete(members).where(eq(members.tenantId, tenant.ctx.slug)).catch(() => {});
  });
}

async function walk(tenant: TestTenant, limit: number): Promise<{ ids: string[]; pages: number }> {
  const repo = makeRenewalsDeps(tenant.ctx.slug).tierUpgradeRepo;
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await repo.listForAdminQueue(tenant.ctx.slug, { limit, ...(cursor ? { cursor } : {}) });
    pages += 1;
    ids.push(...page.items.map((s) => s.suggestionId));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    if (pages > 10) throw new Error('runaway pagination');
  }
  return { ids, pages };
}

describe('#765 — tier-upgrade admin queue keyset paging (live Neon)', () => {
  let a: TestTenant;
  let b: TestTenant;
  let admin: TestUser;
  let seeded: string[];

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    a = await createTestTenant('test-tierq-a');
    b = await createTestTenant('test-tierq-b');
    await seedPlans(a, admin);
    await seedPlans(b, admin);
    seeded = await seedSuggestions(a, 55);
    await seedSuggestions(b, 2);
  }, 240_000);

  afterAll(async () => {
    for (const t of [a, b]) {
      await clear(t).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('walks all 55 exactly once in two pages of 50, newest first, with no row repeated or dropped', async () => {
    const { ids, pages } = await walk(a, 50);
    expect(pages).toBe(2);
    expect(ids).toHaveLength(55);
    expect(new Set(ids).size).toBe(55);
    // Seeded oldest → newest; the queue lists newest first.
    expect(ids).toEqual([...seeded].reverse());
  });

  it('walks the same set at a page size that cuts inside a millisecond', async () => {
    const { ids } = await walk(a, 7);
    expect(ids).toEqual([...seeded].reverse());
  });

  it('counts the whole queue, not one page', async () => {
    const repo = makeRenewalsDeps(a.ctx.slug).tierUpgradeRepo;
    expect(await repo.countForAdminQueue(a.ctx.slug)).toBe(55);
  });

  it('cross-tenant: tenant B walks and counts only its own two', async () => {
    const { ids } = await walk(b, 50);
    expect(ids).toHaveLength(2);
    expect(ids.some((id) => seeded.includes(id))).toBe(false);
    expect(await makeRenewalsDeps(b.ctx.slug).tierUpgradeRepo.countForAdminQueue(b.ctx.slug)).toBe(2);
  });
});
