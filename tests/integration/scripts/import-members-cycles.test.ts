/**
 * F8-completion Slice 1 · Task 1.7 — import-integrated cold-start.
 *
 * The initial SweCham member cohort enters the DB via the one-time
 * `commitMembers` import. Slice 1 adds an INITIAL renewal cycle per
 * imported member, created INSIDE the same batch `runInTenant` tx (so the
 * whole import — members + contacts + cycles — is atomic). The cycle is
 * anchored by data: `period_from = registration_date`, `period_to = +12
 * months`, frozen at the resolved `plan_id` price.
 *
 * Error discipline (OPPOSITE to the createMember onboarding listener): the
 * cycle creation runs IN the batch tx and THROWS on failure → the whole
 * batch rolls back (atomic) → the operator fixes + re-runs (idempotent via
 * `findActiveForMemberInTx` no-op). It does NOT swallow.
 *
 * Live Neon. Constitution Principle I (RLS via runInTenant + cross-tenant
 * isolation) + Principle VIII (state↔audit atomicity).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import type { ValidatedMember } from '@/../scripts/import-members/validate';

const { commitMembers } = await import('@/../scripts/import-members');

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1, website_page_type: 'member_news_update', homepage_logo_category: 'regular',
  directory_listing_size: 'half_page', event_discount_scope: 'all_employees', events_cobranded_access: false,
  cultural_tickets_per_year: 0, m2m_benefits_access: true, business_referrals: true,
  tailor_made_services: false, partnership: null,
};

async function seedPremiumPlan(slug: string, userId: string): Promise<void> {
  await runInTenant({ slug } as never, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: slug, planId: 'premium', planYear: 2026,
      planName: { en: 'Premium Corporate' }, description: { en: 'test' }, sortOrder: 1,
      planCategory: 'corporate', memberTypeScope: 'company',
      // 5_000_000 minor units → 50000.00 THB frozen price.
      annualFeeMinorUnits: 5_000_000,
      includesCorporatePlanId: null, minTurnoverMinorUnits: null, maxTurnoverMinorUnits: null,
      maxDurationYears: null, maxMemberAge: null, benefitMatrix: MATRIX, isActive: true,
      // renewal_tier_bucket defaults to 'regular' (migration default).
      createdBy: userId, updatedBy: userId,
    });
  });
}

let vmSeq = 0;
function vm(over: { planId?: string; regDate?: string; status?: 'active' | 'inactive' }): ValidatedMember {
  vmSeq += 1;
  const email = `cyc${vmSeq}-${randomUUID().slice(0, 8)}@imp.test`;
  return {
    companyName: `Cyc Co ${vmSeq}`,
    legalEntityType: null,
    isVatRegistered: false,
    status: over.status ?? 'active',
    country: 'SE' as ValidatedMember['country'],
    taxId: ('SE' + String(vmSeq).padStart(6, '0')) as ValidatedMember['taxId'],
    planId: over.planId ?? 'premium',
    memberTypeScope: 'company',
    turnoverThb: null,
    registeredCapitalThb: null,
    foundedYear: null,
    website: null,
    description: null,
    registrationDate: new Date(over.regDate ?? '2026-02-10T00:00:00Z'),
    preferredLocale: null,
    city: null, province: null, postalCode: null,
    addressLine1: null, addressLine2: null,
    contacts: [{
      firstName: 'First', lastName: 'Last',
      email: email as ValidatedMember['contacts'][number]['email'],
      phone: null, roleTitle: null, preferredLanguage: 'en' as const,
      isPrimary: true, rowIndex: 100,
    }],
    rowIndices: [100],
  };
}

const cyclesFor = (slug: string) =>
  runInTenant({ slug } as never, async (tx) =>
    tx.select().from(renewalCycles).where(eq(renewalCycles.tenantId, slug)),
  );

const countCycles = (slug: string): Promise<number> =>
  cyclesFor(slug).then((r) => r.length);

const countMembers = (slug: string): Promise<number> =>
  runInTenant({ slug } as never, async (tx) =>
    tx.select({ id: members.memberId }).from(members).where(eq(members.tenantId, slug)),
  ).then((r) => r.length);

describe('commitMembers — initial renewal cycle per imported member (Task 1.7)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let tenantC: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    tenantC = await createTestTenant('test');
    await seedPremiumPlan(tenantA.ctx.slug, user.userId);
    await seedPremiumPlan(tenantB.ctx.slug, user.userId);
    await seedPremiumPlan(tenantC.ctx.slug, user.userId);
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await tenantC.cleanup().catch(() => {});
  });

  it('creates one upcoming cycle per imported member, anchored at registration_date, frozen at the plan price', async () => {
    const m1 = vm({ regDate: '2026-02-10T00:00:00Z' });
    const m2 = vm({ regDate: '2026-05-20T00:00:00Z' });
    const out = await commitMembers(tenantA.ctx, user.userId, [m1, m2], 2026);

    expect(out.membersCreated).toBe(2);
    // cyclesCreated == members created.
    expect(out.cyclesCreated).toBe(2);

    const cycles = await cyclesFor(tenantA.ctx.slug);
    expect(cycles).toHaveLength(2);
    for (const c of cycles) {
      expect(c.status).toBe('upcoming');
      expect(c.frozenPlanPriceThb).toBe('50000.00');
      expect(c.tierAtCycleStart).toBe('regular');
      expect(c.planIdAtCycleStart).toBe('premium');
    }
    // Anchored at each member's registration_date (UTC midnight) + 12 months.
    const anchors = cycles
      .map((c) => c.periodFrom.toISOString())
      .sort();
    expect(anchors).toEqual([
      '2026-02-10T00:00:00.000Z',
      '2026-05-20T00:00:00.000Z',
    ]);
    const ends = cycles.map((c) => c.periodTo.toISOString()).sort();
    expect(ends).toEqual([
      '2027-02-10T00:00:00.000Z',
      '2027-05-20T00:00:00.000Z',
    ]);
  }, 60_000);

  it('an INACTIVE imported member is created but gets NO renewal cycle (PR-C)', async () => {
    // An inactive member is a directory record only — creating a cycle would
    // resurface it in the F8 at-risk / reminder pipeline. Both members are
    // created; only the active one gets a cycle.
    const active = vm({ regDate: '2026-03-01T00:00:00Z', status: 'active' });
    const inactive = vm({ regDate: '2026-03-01T00:00:00Z', status: 'inactive' });
    const out = await commitMembers(tenantC.ctx, user.userId, [active, inactive], 2026);
    expect(out.membersCreated).toBe(2);
    expect(out.cyclesCreated).toBe(1); // only the active member
    expect(await countCycles(tenantC.ctx.slug)).toBe(1);
    expect(await countMembers(tenantC.ctx.slug)).toBe(2);
  }, 60_000);

  it('cold-start: a member with a HISTORICAL registration_date anchors at the CURRENT period (expires_at in the future), not the original (cluster F, 068)', async () => {
    // A long-standing member registered 5+ years ago. With the naive
    // `period_from = registration_date` anchoring, period_to = registration +
    // 12mo would be YEARS in the past → the enter-awaiting + lapse crons would
    // immediately mark a paid-up member lapsed at launch. The cluster-F fix
    // advances period_from by whole term-month multiples (preserving the
    // anniversary) until period_to > now → the member's CURRENT membership year.
    const historical = '2020-03-15T00:00:00Z';
    const m = vm({ regDate: historical });
    const out = await commitMembers(tenantA.ctx, user.userId, [m], 2026);
    expect(out.cyclesCreated).toBe(1);

    const cycles = await cyclesFor(tenantA.ctx.slug);
    // Find the just-created historical-member cycle (companyName is unique via vm()).
    const created = cycles.find(
      (c) => c.periodFrom.getUTCMonth() === 2 && c.periodFrom.getUTCDate() === 15,
    );
    expect(created).toBeDefined();

    const now = Date.now();
    // CRITICAL: expires_at (period_to) is in the FUTURE — the member is in
    // their current period, NOT lapsed at launch.
    expect(created!.periodTo.getTime()).toBeGreaterThan(now);
    // The original naive expiry (2021-03-15) must NOT be used.
    expect(created!.periodTo.toISOString()).not.toBe('2021-03-15T00:00:00.000Z');
    // Anniversary preserved: month=March, day=15 on BOTH ends.
    expect(created!.periodFrom.getUTCMonth()).toBe(2);
    expect(created!.periodFrom.getUTCDate()).toBe(15);
    expect(created!.periodTo.getUTCMonth()).toBe(2);
    expect(created!.periodTo.getUTCDate()).toBe(15);
    // Gapless 12-month window: period_to == period_from + 12 months.
    const pf = created!.periodFrom;
    const expectedTo = new Date(pf);
    expectedTo.setUTCMonth(expectedTo.getUTCMonth() + 12);
    expect(created!.periodTo.toISOString()).toBe(expectedTo.toISOString());
    // The current period contains "now": period_from <= now < period_to.
    expect(created!.periodFrom.getTime()).toBeLessThanOrEqual(now);
  }, 60_000);

  it('is idempotent: a re-run of the SAME member does NOT create a 2nd cycle', async () => {
    const m = vm({});
    const first = await commitMembers(tenantB.ctx, user.userId, [m], 2026);
    expect(first.membersCreated).toBe(1);
    expect(first.cyclesCreated).toBe(1);
    expect(await countCycles(tenantB.ctx.slug)).toBe(1);

    // Re-run the SAME member (same email) → member skipped (already exists),
    // and since the member's create is skipped the cycle step is not reached
    // for it → still exactly one cycle (no duplicate).
    const second = await commitMembers(tenantB.ctx, user.userId, [m], 2026);
    expect(second.membersCreated).toBe(0);
    expect(second.cyclesCreated).toBe(0);
    expect(await countCycles(tenantB.ctx.slug)).toBe(1);
  }, 60_000);

  it('RLS isolation: cycles created under tenantA are invisible to tenantC', async () => {
    const before = await countCycles(tenantC.ctx.slug);
    await commitMembers(
      tenantA.ctx,
      user.userId,
      [vm({ regDate: '2026-03-03T00:00:00Z' })],
      2026,
    );
    // tenantC unchanged — the new cycle landed under tenantA only.
    expect(await countCycles(tenantC.ctx.slug)).toBe(before);
  }, 60_000);

  it('all-or-nothing: a mid-batch cycle-insert failure rolls back ALL member + contact + cycle rows', async () => {
    const good = vm({});
    // A member whose plan_id is not seeded. The member INSERT itself FK-fails
    // (members.plan_id → membership_plans), but even if it did not, the cycle
    // step's loadPlanFrozenFields would throw on the missing plan. Either way
    // the throw propagates → the whole batch rolls back.
    const ghost = vm({ planId: 'ghost-plan-not-seeded' });
    const beforeMembers = await countMembers(tenantC.ctx.slug);
    const beforeCycles = await countCycles(tenantC.ctx.slug);

    await expect(
      commitMembers(tenantC.ctx, user.userId, [good, ghost], 2026),
    ).rejects.toThrow();

    // The good member + its cycle (committed before the ghost failure) MUST
    // be rolled back — atomic batch.
    expect(await countMembers(tenantC.ctx.slug)).toBe(beforeMembers);
    expect(await countCycles(tenantC.ctx.slug)).toBe(beforeCycles);
  }, 60_000);
});
