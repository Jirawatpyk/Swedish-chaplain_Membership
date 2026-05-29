/**
 * Integration: member postal address (migration 0195) vs live Neon.
 *
 * Proves the new structured address columns round-trip end-to-end:
 *   - createMember persists address_line1/2 + city + province + postal_code
 *   - updateMember mutates them (and can clear a field to NULL)
 *   - getMember reads them back through the domain mapper
 *
 * Guards against the F4-R8 class of bug (CLAUDE.md § Gotchas): unit-test
 * mocks hide a schema gap; only a live-Neon insert/update surfaces a
 * missing column or grant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { createMember, updateMember, getMember } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

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

describe('member address integration (migration 0195)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'test-addr-plan';

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
        planName: { en: 'Test Addr Plan' },
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

  it('createMember persists the structured address; updateMember mutates + clears it', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const meta = { actorUserId: user.userId, requestId: `rq-${Date.now()}` };

    const created = await createMember(
      {
        company_name: `Addr Co ${Date.now()}`,
        country: 'TH',
        plan_id: planId,
        plan_year: 2026,
        address_line1: '99 Sukhumvit Rd',
        address_line2: 'Unit 12B',
        city: 'Watthana',
        province: 'Bangkok',
        postal_code: '10110',
        primary_contact: {
          first_name: 'Anong',
          last_name: 'Srisuk',
          email: `addr-${randomUUID().slice(0, 8)}@example.com`,
          preferred_language: 'en' as const,
        },
      },
      meta,
      deps,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const memberId = created.value.memberId;

    // Raw row carries every column.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.memberId, memberId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.addressLine1).toBe('99 Sukhumvit Rd');
    expect(rows[0]!.addressLine2).toBe('Unit 12B');
    expect(rows[0]!.city).toBe('Watthana');
    expect(rows[0]!.province).toBe('Bangkok');
    expect(rows[0]!.postalCode).toBe('10110');

    // Domain mapper surfaces them.
    const read = await getMember(memberId as MemberId, meta, deps);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.member.addressLine1).toBe('99 Sukhumvit Rd');
      expect(read.value.member.city).toBe('Watthana');
      expect(read.value.member.postalCode).toBe('10110');
    }

    // Update one field + clear another (address_line2 → null).
    const updated = await updateMember(
      memberId as MemberId,
      { city: 'Khlong Toei', address_line2: null },
      { ...meta, requestId: `rq-${Date.now()}-u` },
      deps,
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.city).toBe('Khlong Toei');
      expect(updated.value.addressLine2).toBeNull();
      // Untouched fields preserved.
      expect(updated.value.addressLine1).toBe('99 Sukhumvit Rd');
      expect(updated.value.postalCode).toBe('10110');
    }
  });
});
