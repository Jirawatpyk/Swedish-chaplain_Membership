/**
 * F4 §86/§87 — the invoice/receipt buyer block must carry the member's FULL
 * structured address, not just the country code. Pins
 * `memberIdentityAdapter.getForIssue` reading the F3 `address_line1/2`, `city`,
 * `province`, `postal_code` columns (raw SQL) and composing them via
 * `composeBuyerAddress` into the snapshot. Regression guard for the pre-fix
 * stub that set `address = m.country` ("TH"). Also catches a wrong raw-SQL
 * column name (which typecheck cannot).
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

describe('F4 member-identity adapter — composes the full buyer address (§86/§87)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const planId = 'addr-plan';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId,
        planYear: 2026,
        planName: { en: 'Addr Plan' },
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
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('member with full structured address → multi-line block (not the bare country stub)', async () => {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Addr Co',
        country: 'TH',
        addressLine1: '99/1 Rama IV Road',
        addressLine2: 'Unit 12B',
        city: 'Khlong Toei',
        province: 'Bangkok',
        postalCode: '10110',
        planId,
        planYear: 2026,
      });
    });

    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, memberId),
    );
    expect(view).not.toBeNull();
    const address = view!.snapshot.address;
    // The structured parts are read from the F3 columns + composed.
    expect(address).toContain('99/1 Rama IV Road');
    expect(address).toContain('Unit 12B');
    expect(address).toContain('Khlong Toei Bangkok 10110');
    // L-01: the redundant trailing "TH" line is suppressed for a domestic
    // Thai address — the jurisdiction is implicit in the Thai locality.
    expect(address.split('\n')).not.toContain('TH');
    // Not the pre-fix bare-country stub.
    expect(address).not.toBe('TH');
    expect(address.split('\n').length).toBeGreaterThan(1);

    // L-04 — the real issue path uses the FOR UPDATE branch (archive-race
    // lock); assert it selects the same address columns + composes identically.
    const lockedView = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, memberId, {
        forUpdate: true,
      }),
    );
    expect(lockedView).not.toBeNull();
    expect(lockedView!.snapshot.address).toBe(address);
  });

  it('member with NO structured address → snapshot.address degrades to the country code', async () => {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Bare Co',
        country: 'SE',
        planId,
        planYear: 2026,
      });
    });

    const view = await runInTenant(tenant.ctx, (tx) =>
      memberIdentityAdapter.getForIssue(tx, tenant.ctx.slug, memberId),
    );
    expect(view).not.toBeNull();
    expect(view!.snapshot.address).toBe('SE');
  });
});
