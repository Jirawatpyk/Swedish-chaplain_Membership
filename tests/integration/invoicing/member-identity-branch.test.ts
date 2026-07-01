/**
 * 088-invoice-tax-flow-redesign — T028/T030 [US3] the member-identity adapter
 * must surface the §86/4 Head-Office / Branch particular + the VAT-registrant
 * discriminator on the buyer snapshot pinned at issue (FR-008).
 *
 * Live Neon, RLS-scoped tx (mirrors member-identity-member-number.test.ts). A
 * wrong raw-SQL column name (`is_head_office` / `branch_code` /
 * `legal_entity_type`) — which typecheck CANNOT catch — surfaces HERE, so this
 * is the guard the repo gotcha ("unit mocks hide schema gaps") calls for.
 *
 * Requires migration 0232 (members_branch_fields) applied to the dev branch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { memberIdentityAdapter } from '@/modules/invoicing/infrastructure/adapters/member-identity-adapter';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

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

describe('088 US3 — memberIdentityAdapter.getForIssue surfaces §86/4 branch particular', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'branch-plan';

  // Registrant juristic buyer set to a specific branch.
  const branchMemberId = randomUUID();
  // Registrant juristic buyer with NO branch (head office default).
  const headOfficeMemberId = randomUUID();
  // Individual (non-registrant) buyer → fail-closed (no branch line).
  const individualMemberId = randomUUID();
  // NULL legal_entity_type buyer → also fail-closed.
  const unknownTypeMemberId = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Branch Plan' },
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
      await tx.insert(members).values([
        {
          tenantId: tenant.ctx.slug,
          memberId: branchMemberId,
          memberNumber: 1,
          companyName: 'Branch Co., Ltd.',
          legalEntityType: 'company',
          country: 'TH',
          taxId: '0105562000123',
          isHeadOffice: false,
          branchCode: '00042',
          planId,
          planYear: 2026,
        },
        {
          tenantId: tenant.ctx.slug,
          memberId: headOfficeMemberId,
          memberNumber: 2,
          companyName: 'HeadOffice Co., Ltd.',
          legalEntityType: 'company',
          country: 'TH',
          taxId: '0105562000456',
          // isHeadOffice + branchCode take the DB defaults (true / NULL).
          planId,
          planYear: 2026,
        },
        {
          tenantId: tenant.ctx.slug,
          memberId: individualMemberId,
          memberNumber: 3,
          companyName: 'Jane Individual',
          legalEntityType: 'individual',
          country: 'TH',
          planId,
          planYear: 2026,
        },
        {
          tenantId: tenant.ctx.slug,
          memberId: unknownTypeMemberId,
          memberNumber: 4,
          companyName: 'Mystery Co.',
          legalEntityType: null,
          country: 'TH',
          planId,
          planYear: 2026,
        },
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('a VAT-registrant juristic buyer set to a branch → registrant=true, head_office=false, code (FOR UPDATE arm — the real issue path)', async () => {
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, branchMemberId, {
        forUpdate: true,
      }),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.buyer_is_vat_registrant).toBe(true);
    expect(view!.snapshot.buyer_is_head_office).toBe(false);
    expect(view!.snapshot.buyer_branch_code).toBe('00042');
  });

  it('a VAT-registrant juristic buyer with no branch → registrant=true, head_office=true (default), code null (plain SELECT arm)', async () => {
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, headOfficeMemberId),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.buyer_is_vat_registrant).toBe(true);
    expect(view!.snapshot.buyer_is_head_office).toBe(true);
    expect(view!.snapshot.buyer_branch_code).toBeNull();
  });

  it('an individual (non-registrant) buyer → registrant=false (fail-closed — no branch line will render)', async () => {
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, individualMemberId),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.buyer_is_vat_registrant).toBe(false);
  });

  it('a NULL legal_entity_type buyer → registrant=false (fail-closed, distinct from the known-registrant/unknown-branch case)', async () => {
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, unknownTypeMemberId),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.buyer_is_vat_registrant).toBe(false);
  });
});
