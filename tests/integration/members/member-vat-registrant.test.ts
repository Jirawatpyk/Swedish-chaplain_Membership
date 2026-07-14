/**
 * 059 / PR-A Task 6c — `memberVatRegistrantByIdsInTx` + the
 * `runListMemberVatRegistrantByIds` lib wrapper (live Neon Singapore via
 * .env.local).
 *
 * Backs the F6 admin event-detail `buyerIsVatRegistrant` enrichment (the
 * /admin/invoices/new attendee picker's server-truth registrant status for
 * MATCHED members). REPLACES the 064-remediation-B5 tax-id-PRESENCE read.
 *
 * WHY THE QUESTION CHANGED: issuance decides the event document class on the
 * RECORDED `members.is_vat_registered` flag, not on "is tax_id non-blank" — a
 * foreign member may store a passport / work-permit number there. While the
 * picker still asked the TIN question the two disagreed: a TIN-bearing
 * NON-registrant was OFFERED bill_first, then refused at issue with "this buyer
 * has no tax ID" — while visibly having one on screen.
 *
 * Pins:
 *   1. the flag is READ, never inferred — including the case that broke the old
 *      lookup: a member WITH a tax_id who is NOT VAT-registered → false;
 *   2. batching — one call resolves many ids; unknown ids are absent;
 *   3. Principle I — a member seeded in tenant B is INVISIBLE (absent from the
 *      map) when the lookup runs under tenant A's RLS context;
 *   4. wrapper ergonomics — empty input short-circuits to an empty map.
 *
 * All seeded PII is SIMULATED (fake names + fake TINs) — never real member data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { memberVatRegistrantByIdsInTx } from '@/modules/members';
import { runListMemberVatRegistrantByIds } from '@/lib/events-admin-deps';
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

const PLAN_ID = 'vat-registrant-plan';

async function seedMember(
  tenant: TestTenant,
  taxId: string | null,
  isVatRegistered: boolean,
  country: 'TH' | 'SE' = 'TH',
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Simulated VAT Probe Co ${memberId.slice(0, 8)}`,
      country,
      taxId,
      isVatRegistered,
      addressLine1: '1 Simulated VAT Road',
      city: 'Pathum Wan',
      province: 'Bangkok',
      postalCode: '10330',
      planId: PLAN_ID,
      planYear: 2026,
    });
  });
  return memberId;
}

describe('memberVatRegistrantByIdsInTx + runListMemberVatRegistrantByIds (059 Task 6c, live Neon)', () => {
  let a: TestTenant;
  let b: TestTenant;
  let user: TestUser;
  let registrant: string;
  let nonRegistrant: string;
  let tinButNotRegistrant: string;
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
          planName: { en: 'VAT Registrant Probe Plan' },
          description: { en: 'Simulated plan for the VAT-registrant probe' },
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
    registrant = await seedMember(a, '1234567890123', true); // SIMULATED TIN
    nonRegistrant = await seedMember(a, null, false);
    // THE CASE THAT BROKE THE OLD LOOKUP: a real, non-blank tax id on a member
    // who is NOT a VAT registrant. The tax-id-presence read answered `true`
    // here, so the picker offered bill_first — and issuance, which asks the
    // registrant question, refused it.
    tinButNotRegistrant = await seedMember(a, '9999999999999', false);
    foreignMember = await seedMember(b, '9876543210123', true); // SIMULATED TIN
  }, 60_000);

  afterAll(async () => {
    await a.cleanup().catch(() => {});
    await b.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('reads the RECORDED flag — a member WITH a tax id but NOT registered is false', async () => {
    const unknownId = randomUUID();
    const map = await runInTenant(a.ctx, (tx) =>
      memberVatRegistrantByIdsInTx(tx, a.ctx.slug, [
        registrant,
        nonRegistrant,
        tinButNotRegistrant,
        unknownId,
      ]),
    );
    expect(map.get(registrant)).toBe(true);
    expect(map.get(nonRegistrant)).toBe(false);
    // The regression this task closes. The old tax-id-PRESENCE read returned
    // `true` for this member — it only saw a non-blank string — so the picker
    // offered bill_first, and issuance then refused it with "this buyer has no
    // tax ID" while the admin was looking at one on screen.
    expect(map.get(tinButNotRegistrant)).toBe(false);
    expect(map.has(unknownId)).toBe(false);
    expect(map.size).toBe(3);
  });

  it("Principle I — tenant B's member is ABSENT when looked up under tenant A's RLS context", async () => {
    const map = await runListMemberVatRegistrantByIds(a.ctx.slug, [
      registrant,
      foreignMember,
    ]);
    expect(map.get(registrant)).toBe(true);
    // Cross-tenant probe: RLS hides the row — absent, never `false` with a
    // leaked signal.
    expect(map.has(foreignMember)).toBe(false);
  });

  it('wrapper short-circuits an empty id list to an empty map (no DB roundtrip needed)', async () => {
    const map = await runListMemberVatRegistrantByIds(a.ctx.slug, []);
    expect(map.size).toBe(0);
  });
}, 120_000);
