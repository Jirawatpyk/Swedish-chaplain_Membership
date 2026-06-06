/**
 * T-MN-02 — DB-layer backstops for member_number (live Neon).
 *
 * Proves the migration-0209 constraints work INDEPENDENTLY of the
 * application allocator, hit via Drizzle inside runInTenant:
 *   (1) INSERT duplicate (tenant_id, member_number) → UNIQUE violation
 *       (UNIQUE INDEX members_tenant_member_number_uniq).
 *   (2) same member_number in two DIFFERENT tenants is allowed
 *       (control: proves the UNIQUE is per-tenant, not global).
 *
 * The CHECK-rejects-0 / CHECK-rejects-(-1) backstops already live in
 * `migration-0209-post-apply.test.ts` (raw-SQL INSERT against the live
 * positive CHECK). This file deliberately does NOT duplicate them — it
 * adds only the UNIQUE coverage that the post-apply suite lacks, exercised
 * through the Drizzle + runInTenant path (the surface the allocator uses).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
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

const PLAN_ID = 'mn-backstop-plan';

async function seedTenant(tenant: TestTenant, user: TestUser): Promise<void> {
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
      planId: PLAN_ID,
      planYear: 2026,
      planName: { en: 'Backstop Plan' },
      description: { en: 'Test' },
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
}

describe('member_number DB backstops — T-MN-02 (live Neon)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenant(tenant, user);
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('(1) INSERT duplicate (tenant_id, member_number=42) → UNIQUE violation', async () => {
    const firstId = randomUUID();
    // First insert succeeds.
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId: firstId,
        companyName: 'Unique Test Co A',
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        memberNumber: 42,
      }),
    );

    // Second insert with same (tenant_id, member_number=42) must fail.
    await expect(
      runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(), // different PK — duplicate member_number is what fails
          companyName: 'Unique Test Co B',
          country: 'TH',
          planId: PLAN_ID,
          planYear: 2026,
          memberNumber: 42,
        }),
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('(2) same member_number=99 in two DIFFERENT tenants is allowed (constraint is per-tenant)', async () => {
    // Control: prove the UNIQUE is scoped to tenant_id, not global.
    const otherTenant = await createTestTenant('test-chamber');
    try {
      await runInTenant(tenant.ctx, (tx) =>
        tx.insert(members).values({
          tenantId: tenant.ctx.slug,
          memberId: randomUUID(),
          companyName: 'Tenant A Member 99',
          country: 'TH',
          planId: PLAN_ID,
          planYear: 2026,
          memberNumber: 99,
        }),
      );

      // Must also seed prerequisite plan + invoice settings for otherTenant.
      await seedTenant(otherTenant, user);

      // Same member_number=99 in a different tenant — must NOT throw.
      await expect(
        runInTenant(otherTenant.ctx, (tx) =>
          tx.insert(members).values({
            tenantId: otherTenant.ctx.slug,
            memberId: randomUUID(),
            companyName: 'Tenant B Member 99',
            country: 'TH',
            planId: PLAN_ID,
            planYear: 2026,
            memberNumber: 99,
          }),
        ),
      ).resolves.toBeDefined();
    } finally {
      await otherTenant.cleanup().catch(() => {});
    }
  }, 30_000);
});
