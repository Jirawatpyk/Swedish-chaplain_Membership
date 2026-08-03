/**
 * member-billing-address (0284) — live-Neon proof of the optional
 * tax-document billing-address group:
 *
 *   1. createMember with a full group → columns persist + roundtrip through
 *      rowToMember (the aggregate's optional keys are ALWAYS populated by
 *      the repo).
 *   2. updateMember edits one field inside a complete group → persists.
 *   3. updateMember clears the whole group (all 7 null) → all columns NULL.
 *   4. A raw partial-group INSERT violates `members_billing_address_group_ck`
 *      — the DB backstop behind the use-case resulting-state check.
 *   5. A raw bad-format billing_country violates
 *      `members_billing_country_format_ck`.
 *
 * Unit-level rejection paths (billing_address_incomplete / invalid_country)
 * live in tests/unit/members/application/{create,update}-member-billing-
 * address.test.ts; the erasure scrub oracle lives in erase-member.test.ts;
 * the §86/4 snapshot switch lives in
 * tests/integration/invoicing/member-identity-address.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { createMember, updateMember, asMemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
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

const BILLING_INPUT = {
  billing_address_line1: '55 Registered Tax Rd',
  billing_address_line2: 'Tower B',
  billing_sub_district: 'สีลม',
  billing_city: 'เขตบางรัก',
  billing_province: 'กรุงเทพมหานคร',
  billing_postal_code: '10500',
  billing_country: 'TH',
};

/**
 * Flatten a rejected DB call into a searchable string. Drizzle wraps the
 * Postgres error ("violates check constraint …") in a DrizzleQueryError
 * whose top-level message is just "Failed query: …" — the constraint name
 * only appears down the `.cause` chain.
 */
async function captureDbError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    const parts: string[] = [];
    let cur: unknown = e;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    }
    return parts.join(' | ');
  }
}

function goodInput(planId: string) {
  return {
    company_name: `Billing Co ${Date.now()}-${randomUUID().slice(0, 6)}`,
    country: 'TH',
    plan_id: planId,
    plan_year: 2026,
    primary_contact: {
      first_name: 'Anna',
      last_name: 'Andersson',
      email: `anna-${randomUUID().slice(0, 8)}@example.com`,
      preferred_language: 'en' as const,
    },
  };
}

describe('member billing address — live Neon roundtrip + CHECK backstop (0284)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-billing-addr';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantInvoiceSettings).values({
        tenantId: tenant.ctx.slug,
        currencyCode: 'THB',
        vatRate: '0.0700',
        registrationFeeSatang: 100000n,
        legalNameTh: 'Test TH',
        legalNameEn: 'Test EN',
        taxId: '0000000000000',
        registeredAddressTh: 'Test Address TH',
        registeredAddressEn: 'Test Address EN',
        invoiceNumberPrefix: 'INV',
        creditNoteNumberPrefix: 'CN',
      });
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Billing Addr Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
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
  }, 30_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('createMember persists the full group; repo roundtrip populates the aggregate keys', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const result = await createMember(
      { ...goodInput(planId), ...BILLING_INPUT },
      { actorUserId: user.userId, requestId: `rq-ba-create-${Date.now()}` },
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // Raw column oracle.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, result.value.memberId)),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.billingAddressLine1).toBe('55 Registered Tax Rd');
    expect(row.billingAddressLine2).toBe('Tower B');
    expect(row.billingSubDistrict).toBe('สีลม');
    expect(row.billingCity).toBe('เขตบางรัก');
    expect(row.billingProvince).toBe('กรุงเทพมหานคร');
    expect(row.billingPostalCode).toBe('10500');
    expect(row.billingCountry).toBe('TH');

    // rowToMember roundtrip — the aggregate's optional keys are populated.
    const loaded = await deps.memberRepo.findById(
      tenant.ctx,
      result.value.memberId,
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.billingAddressLine1).toBe('55 Registered Tax Rd');
    expect(loaded.value.billingCountry).toBe('TH');
  });

  it('updateMember edits one field inside a complete group, then clears the whole group', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const created = await createMember(
      { ...goodInput(planId), ...BILLING_INPUT },
      { actorUserId: user.userId, requestId: `rq-ba-upd-${Date.now()}` },
      deps,
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const memberId = asMemberId(created.value.memberId);

    // Single-field edit — resulting state still complete.
    const edited = await updateMember(
      memberId,
      { billing_postal_code: '10110' },
      { actorUserId: user.userId, requestId: `rq-ba-upd2-${Date.now()}` },
      deps,
    );
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.billingPostalCode).toBe('10110');
    expect(edited.value.billingAddressLine1).toBe('55 Registered Tax Rd');

    // Clear the whole group (the toggle-off payload shape).
    const cleared = await updateMember(
      memberId,
      {
        billing_address_line1: null,
        billing_address_line2: null,
        billing_sub_district: null,
        billing_city: null,
        billing_province: null,
        billing_postal_code: null,
        billing_country: null,
      },
      { actorUserId: user.userId, requestId: `rq-ba-clr-${Date.now()}` },
      deps,
    );
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    if (!cleared.ok) return;

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, memberId)),
    );
    const row = rows[0]!;
    expect(row.billingAddressLine1).toBeNull();
    expect(row.billingAddressLine2).toBeNull();
    expect(row.billingSubDistrict).toBeNull();
    expect(row.billingCity).toBeNull();
    expect(row.billingProvince).toBeNull();
    expect(row.billingPostalCode).toBeNull();
    expect(row.billingCountry).toBeNull();
  });

  it('DB backstop: a raw partial-group INSERT violates members_billing_address_group_ck', async () => {
    const errText = await captureDbError(
      runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Partial Billing Co',
          country: 'TH',
          planId,
          planYear: 2026,
          // Partial group: city without line1/postal/country.
          billingCity: 'Bangkok',
        }),
      ),
    );
    expect(errText).toContain('members_billing_address_group_ck');
  });

  it('DB backstop: a raw lowercase billing_country violates members_billing_country_format_ck', async () => {
    const errText = await captureDbError(
      runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Bad Country Billing Co',
          country: 'TH',
          planId,
          planYear: 2026,
          billingAddressLine1: '9 Tax Rd',
          billingCity: 'Bangkok',
          billingPostalCode: '10500',
          billingCountry: 'th', // lowercase — use-cases always uppercase via the VO
        }),
      ),
    );
    expect(errText).toContain('members_billing_country_format_ck');
  });
});
