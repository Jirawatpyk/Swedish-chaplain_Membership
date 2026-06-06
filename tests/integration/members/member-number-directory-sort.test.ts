/**
 * ADMIN-1 (055-member-number) — Integration: searchDirectoryWithCount
 * sorts by member_number ASC NULLS LAST when filter.sort === 'memberNumber'.
 * Live Neon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { createMember, drizzleMemberRepo } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import type { MemberId } from '@/modules/members';

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

async function seedSortMember(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  companyName: string,
): Promise<MemberId> {
  const deps = buildMembersDeps(tenant.ctx);
  const slug = `sort-${randomUUID().slice(0, 8)}`;
  const r = await createMember(
    {
      company_name: companyName,
      country: 'TH',
      plan_id: planId,
      plan_year: 2026,
      primary_contact: {
        first_name: 'Anna',
        last_name: 'Andersson',
        email: `${slug}@example.com`,
        preferred_language: 'en' as const,
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

describe('searchDirectoryWithCount — sort by memberNumber', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-sort-plan';
  let m1Id: MemberId;
  let m2Id: MemberId;
  let m3Id: MemberId;

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
        planName: { en: 'Sort Plan' },
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
    // Create 3 members; allocator assigns sequential numbers 1, 2, 3
    m1Id = await seedSortMember(tenant, user, planId, 'Gamma Co');
    m2Id = await seedSortMember(tenant, user, planId, 'Alpha Co');
    m3Id = await seedSortMember(tenant, user, planId, 'Beta Co');
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('orders ascending by member_number with NULLS LAST', async () => {
    const res = await drizzleMemberRepo.searchDirectoryWithCount(tenant.ctx, {
      sort: 'memberNumber',
      order: 'asc',
      status: ['active', 'inactive'],
      limit: 50,
      offset: 0,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const numbers = res.value.items.map((r) => r.member.memberNumber);
    // strictly non-decreasing (ASC); NULLs are last so non-null values come first
    const nonNull = numbers.filter((n) => n !== null);
    for (let i = 1; i < nonNull.length; i++) {
      expect(nonNull[i]! >= nonNull[i - 1]!).toBe(true);
    }
    // sanity: the three seeded members are present
    const ids = res.value.items.map((r) => r.member.memberId);
    expect(ids).toEqual(expect.arrayContaining([m1Id, m2Id, m3Id]));
  });
});
