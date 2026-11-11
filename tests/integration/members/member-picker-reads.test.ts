/**
 * #89 — the invoice pickers' slim member reads on live Neon (Principle I).
 *
 * - `memberPickerOptionsInTx` (the /admin/invoices/new preload) returns this
 *   tenant's active and inactive members, never an archived or erased one,
 *   never another tenant's.
 * - `memberCompanyNamesByIdsInTx` (the invoices list's draft buyer names)
 *   names this tenant's members of any status except erased; another tenant's
 *   id is absent.
 *
 * All seeded data is SIMULATED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { memberCompanyNamesByIdsInTx, memberPickerOptionsInTx } from '@/modules/members';
import { runListMemberNamesByIds, runListMemberPickerOptions } from '@/lib/members-picker-deps';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
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

const PLAN_ID = 'picker-reads-plan';

async function seedMember(
  tenant: TestTenant,
  status: 'active' | 'inactive' | 'archived',
  erased = false,
): Promise<string> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Simulated Picker Co ${memberId.slice(0, 8)}`,
      country: 'TH',
      addressLine1: '1 Simulated Picker Road',
      city: 'Pathum Wan',
      province: 'Bangkok',
      postalCode: '10330',
      planId: PLAN_ID,
      planYear: 2026,
      status,
      erasedAt: erased ? new Date() : null,
    });
  });
  return memberId;
}

describe('member picker reads (#89, live Neon)', () => {
  let a: TestTenant;
  let b: TestTenant;
  let user: TestUser;
  let active: string;
  let inactive: string;
  let archived: string;
  let erased: string;
  let foreign: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    a = pair.a;
    b = pair.b;
    for (const t of [a, b]) {
      await runInTenant(t.ctx, async (tx) => {
        await tx.insert(membershipPlans).values({
          tenantId: t.ctx.slug,
          planId: PLAN_ID,
          planYear: 2026,
          planName: { en: 'Picker Reads Probe Plan' },
          description: { en: 'Simulated plan for the picker-reads probe' },
          sortOrder: 13,
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
    active = await seedMember(a, 'active');
    inactive = await seedMember(a, 'inactive');
    archived = await seedMember(a, 'archived');
    erased = await seedMember(a, 'active', true);
    foreign = await seedMember(b, 'active');
  }, 60_000);

  afterAll(async () => {
    await a.cleanup().catch(() => {});
    await b.cleanup().catch(() => {});
    await deleteTestUser(user).catch(() => {});
  });

  it('the preload holds this tenant\'s active and inactive members only, with the four picker fields', async () => {
    const rows = await runInTenant(a.ctx, (tx) =>
      memberPickerOptionsInTx(tx, a.ctx.slug, { statuses: ['active', 'inactive'], limit: 100 }),
    );
    const ids = rows.map((r) => r.memberId).sort();
    expect(ids).toEqual([active, inactive].sort());
    expect(Object.keys(rows[0]!).sort()).toEqual(['companyName', 'memberId', 'planId', 'planYear']);
  });

  it('Principle I — tenant B\'s member never reaches tenant A\'s preload', async () => {
    const rows = await runListMemberPickerOptions(a.ctx.slug, { statuses: ['active'], limit: 100 });
    expect(rows.map((r) => r.memberId)).not.toContain(foreign);
  });

  it('names by id: any status but erased; another tenant\'s id is absent', async () => {
    const names = await runInTenant(a.ctx, (tx) =>
      memberCompanyNamesByIdsInTx(tx, a.ctx.slug, [active, inactive, archived, erased, foreign]),
    );
    expect([...names.keys()].sort()).toEqual([active, inactive, archived].sort());
    const viaWrapper = await runListMemberNamesByIds(a.ctx.slug, [foreign]);
    expect(viaWrapper.size).toBe(0);
  });
}, 120_000);
