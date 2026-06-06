/**
 * 055-member-number — the member-identity adapter must surface `member_number`
 * on the snapshot for a MEMBERSHIP invoice (write path). Pins
 * `memberIdentityAdapter.getForIssue` reading the F3 `members.member_number`
 * column (raw SQL) into the buyer snapshot pinned at issue (FR-038).
 *
 * Live Neon, RLS-scoped tx. Mirrors the sibling `member-identity-address.test.ts`
 * seed posture (Drizzle insert via a throwaway tenant + a `membership_plans`
 * row). A wrong raw-SQL column name (which typecheck cannot catch) surfaces here.
 *
 * Depends on members-module migration 0209 having added `members.member_number`
 * (foundation group). Run `pnpm drizzle-kit migrate` before this test.
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

// A fixed, known member number so the assertion can pin the exact value. The
// throwaway tenant isolates the per-tenant UNIQUE index, so a low literal (42)
// never collides with anything else in this file.
const MEMBER_NUMBER = 42;

describe('055 — memberIdentityAdapter.getForIssue snapshots member_number', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'mn-plan';
  const memberId = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'MN Plan' },
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
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: MEMBER_NUMBER,
        companyName: 'MemberNo Co',
        country: 'TH',
        addressLine1: '99/1 Rama IV Road',
        city: 'Khlong Toei',
        province: 'Bangkok',
        postalCode: '10110',
        taxId: '0105562000123',
        planId,
        planYear: 2026,
      });
    });
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('puts the member_number on the snapshot (plain SELECT arm)', async () => {
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, memberId),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.member_number).toBe(MEMBER_NUMBER);
  });

  it('puts the member_number on the snapshot (FOR UPDATE arm — the real issue path)', async () => {
    // The issue-invoice path takes the FOR UPDATE branch (archive-race lock);
    // it must SELECT member_number identically to the plain arm.
    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, memberId, {
        forUpdate: true,
      }),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.member_number).toBe(MEMBER_NUMBER);
  });
});
