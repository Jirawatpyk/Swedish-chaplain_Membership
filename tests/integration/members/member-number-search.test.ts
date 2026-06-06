/**
 * ADMIN-2 (055-member-number) — Integration: directoryQFilter includes
 * exact member-number match when q parses as a positive integer
 * (`SCCM-0001`, `0001`, `1`). Live Neon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { createMember, drizzleMemberRepo } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import { members } from '@/modules/members/infrastructure/db/schema-members';
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

async function seedSearchMember(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  companyName: string,
): Promise<{ memberId: MemberId; memberNumber: number }> {
  const deps = buildMembersDeps(tenant.ctx);
  const slug = `srch-${randomUUID().slice(0, 8)}`;
  const r = await createMember(
    {
      company_name: companyName,
      country: 'TH',
      plan_id: planId,
      plan_year: 2026,
      primary_contact: {
        first_name: 'Test',
        last_name: 'Contact',
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
  // createMember returns { memberId, contactId } — fetch memberNumber from DB
  const rows = await runInTenant(tenant.ctx, (tx) =>
    tx.select().from(members).where(eq(members.memberId, r.value.memberId)),
  );
  const mn = rows[0]?.memberNumber;
  if (mn === null || mn === undefined) throw new Error('Expected memberNumber to be non-null after createMember');
  return { memberId: r.value.memberId, memberNumber: mn };
}

describe('searchDirectoryWithCount — search by member number', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-search-plan';

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
        planName: { en: 'Search Plan' },
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
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('matches a member by its formatted number, padded number, or bare integer', async () => {
    const { memberId, memberNumber } = await seedSearchMember(
      tenant,
      user,
      planId,
      'Zeta Holdings',
    );
    const n = memberNumber;

    for (const q of [`SCCM-${String(n).padStart(4, '0')}`, String(n).padStart(4, '0'), String(n)]) {
      const res = await drizzleMemberRepo.searchDirectoryWithCount(tenant.ctx, {
        q,
        status: ['active', 'inactive'],
        limit: 50,
        offset: 0,
      });
      expect(res.ok, `q="${q}" should succeed`).toBe(true);
      if (!res.ok) continue;
      const ids = res.value.items.map((r) => r.member.memberId);
      expect(ids, `q="${q}" should contain target member`).toContain(memberId);
    }
  });

  it('falls back to company/contact ILIKE when q is not a member number', async () => {
    const { memberId } = await seedSearchMember(tenant, user, planId, 'Acme Trading');
    const res = await drizzleMemberRepo.searchDirectoryWithCount(tenant.ctx, {
      q: 'Acme',
      status: ['active', 'inactive'],
      limit: 50,
      offset: 0,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.items.map((r) => r.member.memberId)).toContain(memberId);
  });
});
