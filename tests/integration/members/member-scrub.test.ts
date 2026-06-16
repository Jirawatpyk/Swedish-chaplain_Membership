/**
 * COMP-1 US1 (Member Erasure, Task 3) — Integration: members anonymise-in-place.
 *
 * Exercises `MemberRepo.scrubPiiInTx` against live Neon with a seeded tenant +
 * member. `company_name` is NOT NULL so it takes the non-PII SENTINEL
 * `[erased]`; every other PII-bearing column — including the business
 * quasi-identifiers `turnover_thb` + `founded_year` (GDPR Recital 26
 * re-identification at small-chamber scale) — is NULLed. `erased_at` is set.
 * Identity (`member_id`, `member_number`, `plan_*`), dates, and `status` are
 * preserved (erasure is orthogonal to archive). `country` (a 2-letter ISO code,
 * low re-identification value) and `preferred_locale` (a UX setting) are kept.
 *
 * Reuses the live-Neon harness shared by the Task 2 contacts scrub
 * (`contact-scrub.test.ts`): same tenant + fee/plan seed + BYPASSRLS raw select.
 * No mocks — the whole point is that the UPDATE holds end-to-end against real
 * Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import type { MemberId } from '@/modules/members';
import { drizzleMemberRepo } from '@/modules/members/infrastructure/db/drizzle-member-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// ---- Test scaffold ---------------------------------------------------------

interface SeededMember {
  memberId: string;
}

async function seedMember(
  tenant: TestTenant,
  fields: {
    companyName: string;
    taxId: string;
    website: string;
    description: string;
    notes: string;
    foundedYear: number;
    turnoverThb: number;
    addressLine1: string;
    city: string;
    province: string;
    postalCode: string;
    blockedReason: string;
    riskScore: number;
    riskScoreBand: string;
    riskScoreFactors: Record<string, unknown>;
  },
): Promise<SeededMember> {
  const memberId = randomUUID();
  const blockedByUserId = randomUUID();

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: fields.companyName,
      legalEntityType: 'Co., Ltd.',
      country: 'TH',
      taxId: fields.taxId,
      website: fields.website,
      description: fields.description,
      notes: fields.notes,
      foundedYear: fields.foundedYear,
      turnoverThb: fields.turnoverThb,
      addressLine1: fields.addressLine1,
      addressLine2: 'Floor 12',
      city: fields.city,
      province: fields.province,
      postalCode: fields.postalCode,
      preferredLocale: 'sv',
      planId: 'test-plan',
      planYear: 2026,
      status: 'active',
      // H1 additions — F8-era admin free-text + risk cluster must scrub too.
      blockedFromAutoReactivation: true,
      blockedFromAutoReactivationAt: new Date('2026-05-01T00:00:00.000Z'),
      blockedFromAutoReactivationSetByUserId: blockedByUserId,
      blockedFromAutoReactivationReason: fields.blockedReason,
      riskScore: fields.riskScore,
      riskScoreBand: fields.riskScoreBand,
      riskScoreFactors: fields.riskScoreFactors,
      riskScoreLastComputedAt: new Date('2026-05-02T00:00:00.000Z'),
      riskSnoozedUntil: new Date('2026-07-01T00:00:00.000Z'),
    });
  });

  return { memberId };
}

/** Raw select via the BYPASSRLS owner role so the assertion sees the row. */
async function rawSelectMember(memberId: string) {
  const rows = await db
    .select({
      member_id: members.memberId,
      member_number: members.memberNumber,
      plan_id: members.planId,
      status: members.status,
      company_name: members.companyName,
      legal_entity_type: members.legalEntityType,
      tax_id: members.taxId,
      website: members.website,
      description: members.description,
      notes: members.notes,
      founded_year: members.foundedYear,
      turnover_thb: members.turnoverThb,
      address_line1: members.addressLine1,
      address_line2: members.addressLine2,
      city: members.city,
      province: members.province,
      postal_code: members.postalCode,
      country: members.country,
      preferred_locale: members.preferredLocale,
      // H1 — F8-era admin free-text + risk cluster (scrubbed) and the two
      // non-PII flags/timestamps (kept).
      blocked_reason: members.blockedFromAutoReactivationReason,
      blocked_set_by_user_id: members.blockedFromAutoReactivationSetByUserId,
      risk_score: members.riskScore,
      risk_score_band: members.riskScoreBand,
      risk_score_factors: members.riskScoreFactors,
      risk_score_last_computed_at: members.riskScoreLastComputedAt,
      risk_snoozed_until: members.riskSnoozedUntil,
      blocked_from_auto_reactivation: members.blockedFromAutoReactivation,
      blocked_at: members.blockedFromAutoReactivationAt,
      erased_at: members.erasedAt,
    })
    .from(members)
    .where(eq(members.memberId, memberId))
    .limit(1);
  return rows[0];
}

// ---- Test suite ------------------------------------------------------------

describe('MemberRepo.scrubPiiInTx', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // Seed fee config + plan so the members FK `(tenant_id, plan_id,
    // plan_year) → membership_plans` is satisfied.
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
        planId: 'test-plan',
        planYear: 2026,
        planName: { en: 'Test Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        createdBy: admin.userId,
        updatedBy: admin.userId,
        benefitMatrix: {
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
        },
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
    await deleteTestUser(admin);
  });

  it('NULLs PII incl. business quasi-identifiers, sentinels company_name, sets erased_at, keeps identity', async () => {
    const { memberId } = await seedMember(tenant, {
      companyName: 'Volvo Trucks (Thailand) Ltd.',
      taxId: '0105536000001',
      website: 'https://volvo.example',
      description: 'Heavy vehicles',
      notes: 'VIP — board contact',
      foundedYear: 1995,
      turnoverThb: 250_000_000,
      addressLine1: '99 Rama IV Rd',
      city: 'Bangkok',
      province: 'Bangkok',
      postalCode: '10500',
      // Free-text admin reason that can name / email the member (PII class of `notes`).
      blockedReason: 'BLOCKED: repeated chargebacks — contact john@example.com',
      riskScore: 87,
      riskScoreBand: 'critical',
      riskScoreFactors: { late_payments: 3, lapsed_renewals: 1, complaint_count: 2 },
    });
    const erasedAt = new Date('2026-06-16T00:00:00.000Z');

    const result = await runInTenant(tenant.ctx, (tx) =>
      drizzleMemberRepo.scrubPiiInTx(tx, memberId as MemberId, { erasedAt }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const row = (await rawSelectMember(memberId))!;
    expect(row.company_name).toBe('[erased]');
    expect(row.tax_id).toBeNull();
    expect(row.website).toBeNull();
    expect(row.description).toBeNull();
    expect(row.notes).toBeNull();
    expect(row.founded_year).toBeNull();
    expect(row.turnover_thb).toBeNull();
    expect(row.address_line1).toBeNull();
    expect(row.address_line2).toBeNull();
    expect(row.city).toBeNull();
    expect(row.province).toBeNull();
    expect(row.postal_code).toBeNull();
    expect(row.legal_entity_type).toBeNull();
    expect(row.erased_at).not.toBeNull();
    // H1 — F8-era admin free-text + risk cluster scrubbed to NULL. The blocked-
    // reactivation cluster collapses AS A UNIT (the 0094 consistency CHECK
    // forbids flag=TRUE without provenance): flag→FALSE, all four cols cleared.
    expect(row.blocked_reason).toBeNull();
    expect(row.blocked_set_by_user_id).toBeNull();
    expect(row.blocked_from_auto_reactivation).toBe(false);
    expect(row.blocked_at).toBeNull();
    expect(row.risk_score).toBeNull();
    expect(row.risk_score_band).toBeNull();
    expect(row.risk_score_factors).toBeNull();
    expect(row.risk_score_last_computed_at).toBeNull();
    expect(row.risk_snoozed_until).toBeNull();
    // Identity + non-PII quasi-aggregate columns preserved.
    expect(row.member_id).toBe(memberId);
    expect(row.member_number).toBeGreaterThan(0);
    expect(row.plan_id).toBeTruthy();
    expect(row.status).toBe('active'); // erasure does NOT change status
    expect(row.country).toBe('TH'); // 2-letter ISO, kept
    expect(row.preferred_locale).toBe('sv'); // UX setting, kept
  }, 30_000);
});
