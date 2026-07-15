/**
 * 088-invoice-tax-flow-redesign — T028/T030 [US3] the member-identity adapter
 * must surface the §86/4 Head-Office / Branch particular + the VAT-registrant
 * discriminator on the buyer snapshot pinned at issue (FR-008).
 *
 * Live Neon, RLS-scoped tx (mirrors member-identity-member-number.test.ts). A
 * wrong raw-SQL column name (`is_head_office` / `branch_code` /
 * `is_vat_registered`) — which typecheck CANNOT catch — surfaces HERE, so this
 * is the guard the repo gotcha ("unit mocks hide schema gaps") calls for.
 *
 * WHY THIS FILE IS LOAD-BEARING: the adapter casts its raw-SQL result with
 * `as unknown as Array<{…}>`, so the compiler is blind in BOTH directions — a
 * column in the row TYPE but missing from the SQL yields `undefined` at runtime
 * and still compiles. And there are TWO byte-identical SELECT arms (a
 * `FOR UPDATE` lock and a plain read) that must be edited in lockstep. Every
 * assertion below therefore exercises a NAMED arm, and the registrant flag is
 * asserted on BOTH.
 *
 * 059 / PR-A Task 3 — the discriminator is now the RECORDED
 * `members.is_vat_registered` column, never guessed from `legal_entity_type`.
 * Requires migrations 0232 (members_branch_fields) + 0246 (is_vat_registered)
 * applied to the dev branch.
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

  // VAT-registrant buyer set to a specific branch.
  const branchMemberId = randomUUID();
  // VAT-registrant buyer with NO branch (head office default).
  const headOfficeMemberId = randomUUID();
  // Non-registrant buyer → fail-closed (no branch line).
  const nonRegistrantMemberId = randomUUID();
  // 059 / PR-A — the discriminator is the RECORDED flag, NOT the legal form. A
  // juristic `legal_entity_type` with `is_vat_registered = false` must still
  // come back false: this member is the regression guard for the deleted
  // `isVatRegistrantEntityType` guess, which returned TRUE for exactly this row.
  const juristicNotRegisteredMemberId = randomUUID();

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
          isVatRegistered: true,
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
          isVatRegistered: true,
          // isHeadOffice + branchCode take the DB defaults (true / NULL).
          planId,
          planYear: 2026,
        },
        {
          tenantId: tenant.ctx.slug,
          memberId: nonRegistrantMemberId,
          memberNumber: 3,
          companyName: 'Jane Individual',
          legalEntityType: 'individual',
          country: 'TH',
          // isVatRegistered takes the DB default (false).
          planId,
          planYear: 2026,
        },
        {
          tenantId: tenant.ctx.slug,
          memberId: juristicNotRegisteredMemberId,
          memberNumber: 4,
          companyName: 'Below-Threshold Co., Ltd.',
          // A JURISTIC entity type — the deleted guess would have said "not
          // 'individual', therefore a registrant" and printed a branch line.
          legalEntityType: 'company',
          country: 'TH',
          isVatRegistered: false,
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

  it('a non-registrant buyer → registrant=false (fail-closed — no branch line will render)', async () => {
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(
        tx,
        tenant.ctx.slug,
        nonRegistrantMemberId,
      ),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.buyer_is_vat_registrant).toBe(false);
  });

  // 059 / PR-A Task 3 — the regression guard for the deleted guess. This member
  // is `legal_entity_type = 'company'` (juristic) but `is_vat_registered = false`
  // (below the §85/1 turnover threshold). `isVatRegistrantEntityType` returned
  // TRUE here — "any string that is not 'individual'" — and would have printed a
  // §86/4 Head-Office line on a NON-registrant's tax document. The recorded flag
  // is the only thing that decides.
  it('a JURISTIC buyer who is not VAT-registered → registrant=false (the legal form does NOT decide)', async () => {
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(
        tx,
        tenant.ctx.slug,
        juristicNotRegisteredMemberId,
      ),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.buyer_is_vat_registrant).toBe(false);
  });

  // The two raw SELECTs are SEPARATE SQL strings behind an `as unknown as` cast.
  // A column added to one arm and not the other compiles clean and silently
  // yields `undefined` here — which is neither true nor false, and would sail
  // past a loose assertion. Assert the flag on BOTH arms, strictly.
  it('the snapshot carries the RECORDED flag, from BOTH SELECT arms', async () => {
    const plain = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, branchMemberId, {
        forUpdate: false,
      }),
    );
    expect(plain!.snapshot.buyer_is_vat_registrant).toBe(true);

    const locked = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, branchMemberId, {
        forUpdate: true,
      }),
    );
    expect(locked!.snapshot.buyer_is_vat_registrant).toBe(true);

    // Both arms must agree — a drifted column would make one of them undefined.
    expect(locked!.snapshot.buyer_is_vat_registrant).toBe(
      plain!.snapshot.buyer_is_vat_registrant,
    );
  });
});
