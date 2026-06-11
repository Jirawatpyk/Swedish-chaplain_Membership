/**
 * 064 remediation B5 — `memberTinPresenceByIdsInTx` + the
 * `runListMemberTinPresenceByIds` lib wrapper (live Neon Singapore via
 * .env.local).
 *
 * The read backs the F6 admin event-detail `buyerHasTin` enrichment (the
 * /admin/invoices/new attendee picker's server-truth TIN presence for
 * MATCHED members). Pins:
 *
 *   1. presence semantics — non-blank tax_id → true; NULL → false;
 *      whitespace-only → false (mirrors the F4 Domain `buyerHasTin` trim);
 *   2. batching — one call resolves many ids; unknown ids are absent;
 *   3. Principle I — a member seeded in tenant B is INVISIBLE (absent from
 *      the map) when the lookup runs under tenant A's RLS context;
 *   4. wrapper ergonomics — empty input short-circuits to an empty map.
 *
 * All seeded PII is SIMULATED (fake names + fake TINs) — never real
 * member data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { memberTinPresenceByIdsInTx } from '@/modules/members';
import { runListMemberTinPresenceByIds } from '@/lib/events-admin-deps';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
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

const PLAN_ID = 'tin-presence-plan';

async function seedMember(
  tenant: TestTenant,
  taxId: string | null,
  // `members_th_tax_id_format` CHECK forces TH tax ids to ^[0-9]{13}$ —
  // the whitespace-only case is only representable on a non-TH member.
  country: 'TH' | 'SE' = 'TH',
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Simulated TIN Probe Co ${memberId.slice(0, 8)}`,
      country,
      taxId,
      addressLine1: '1 Simulated TIN Road',
      city: 'Pathum Wan',
      province: 'Bangkok',
      postalCode: '10330',
      planId: PLAN_ID,
      planYear: 2026,
    });
  });
  return memberId;
}

describe('memberTinPresenceByIdsInTx + runListMemberTinPresenceByIds (064 B5, live Neon)', () => {
  let a: TestTenant;
  let b: TestTenant;
  let user: TestUser;
  let withTin: string;
  let withoutTin: string;
  let whitespaceTin: string;
  let foreignMember: string; // seeded in tenant B

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    a = pair.a;
    b = pair.b;
    for (const t of [a, b]) {
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId: PLAN_ID,
          planYear: 2026,
          planName: { en: 'TIN Presence Probe Plan' },
          description: { en: 'Simulated plan for the B5 TIN-presence probe' },
          sortOrder: 12,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 1_000_000,
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
    withTin = await seedMember(a, '1234567890123'); // SIMULATED TIN
    withoutTin = await seedMember(a, null);
    whitespaceTin = await seedMember(a, '   ', 'SE'); // whitespace-only — non-TH (TH CHECK forbids it)
    foreignMember = await seedMember(b, '9876543210123'); // SIMULATED TIN
  }, 60_000);

  afterAll(async () => {
    await a.cleanup().catch(() => {});
    await b.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('batched presence: non-blank → true, NULL → false, whitespace-only → false, unknown id absent', async () => {
    const unknownId = randomUUID();
    const map = await runInTenant(a.ctx, (tx) =>
      memberTinPresenceByIdsInTx(tx, a.ctx.slug, [
        withTin,
        withoutTin,
        whitespaceTin,
        unknownId,
      ]),
    );
    expect(map.get(withTin)).toBe(true);
    expect(map.get(withoutTin)).toBe(false);
    // Whitespace-only is NOT a TIN — mirrors the F4 Domain buyerHasTin trim
    // so the picker preview agrees with what issuance will decide.
    expect(map.get(whitespaceTin)).toBe(false);
    expect(map.has(unknownId)).toBe(false);
    expect(map.size).toBe(3);
  });

  it("Principle I — tenant B's member is ABSENT when looked up under tenant A's RLS context", async () => {
    const map = await runListMemberTinPresenceByIds(a.ctx.slug, [
      withTin,
      foreignMember,
    ]);
    expect(map.get(withTin)).toBe(true);
    // Cross-tenant probe: RLS hides the row — absent, never `false` with a
    // leaked presence signal.
    expect(map.has(foreignMember)).toBe(false);
  });

  it('wrapper short-circuits an empty id list to an empty map (no DB roundtrip needed)', async () => {
    const map = await runListMemberTinPresenceByIds(a.ctx.slug, []);
    expect(map.size).toBe(0);
  });
}, 120_000);
