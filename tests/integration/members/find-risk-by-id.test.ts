/**
 * B18 — integration test for `MemberRepo.findRiskById` (the engagement-score
 * source on the member-profile page, FR-007a). Live Neon Singapore, throwaway
 * tenants. Covers: a scored member returns its risk_score + band; an un-scored
 * member returns null/null; a cross-tenant id returns not_found (RLS), proving
 * the read self-scopes via runInTenant like findById.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { asMemberId, type MemberId } from '@/modules/members';
import { drizzleMemberRepo } from '@/modules/members/infrastructure/db/drizzle-member-repo';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const PLAN_ID = 'test-risk-plan';

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

async function seedPlan(slug: string, userId: string): Promise<void> {
  await runInTenant({ slug } as never, async (tx) => {
    await tx.insert(tenantInvoiceSettings).values({
      tenantId: slug,
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
      tenantId: slug,
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Risk Plan' },
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
      createdBy: userId,
      updatedBy: userId,
    });
  });
}

async function seedMember(
  tenant: TestTenant,
  opts: { riskScore: number | null; riskScoreBand: string | null },
): Promise<MemberId> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      companyName: `RiskCo ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId: PLAN_ID,
      planYear: 2026,
      registrationDate: new Date('2026-01-01').toISOString().slice(0, 10),
      registrationFeePaid: false,
      status: 'active',
      archivedAt: null,
      riskScore: opts.riskScore,
      riskScoreBand: opts.riskScoreBand,
    });
  });
  return asMemberId(memberId);
}

describe('MemberRepo.findRiskById — integration (B18)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let scoredId: MemberId;
  let unscoredId: MemberId;

  beforeAll(async () => {
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    user = await createActiveTestUser('admin');
    await seedPlan(tenantA.ctx.slug, user.userId);
    scoredId = await seedMember(tenantA, {
      riskScore: 60,
      riskScoreBand: 'warning',
    });
    unscoredId = await seedMember(tenantA, {
      riskScore: null,
      riskScoreBand: null,
    });
  });

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('returns the seeded risk score + band for a scored member', async () => {
    const r = await drizzleMemberRepo.findRiskById(tenantA.ctx, scoredId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ riskScore: 60, riskScoreBand: 'warning' });
    }
  });

  it('returns null/null for an un-scored member', async () => {
    const r = await drizzleMemberRepo.findRiskById(tenantA.ctx, unscoredId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ riskScore: null, riskScoreBand: null });
    }
  });

  it('returns not_found for an unknown member id', async () => {
    const r = await drizzleMemberRepo.findRiskById(
      tenantA.ctx,
      asMemberId(randomUUID()),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('repo.not_found');
  });

  it('returns not_found for a cross-tenant member id (RLS self-scoping)', async () => {
    // tenantA's scored member, queried under tenantB's context → RLS hides it.
    const r = await drizzleMemberRepo.findRiskById(tenantB.ctx, scoredId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('repo.not_found');
  });
});
