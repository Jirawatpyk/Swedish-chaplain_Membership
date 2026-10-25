/**
 * 126 (#8, #5) — createMember plan guards on live Neon.
 *
 *   #8 createMember fast-failed on `isSoftDeleted` from a pre-tx snapshot
 *      but took no `plans:softdelete` advisory lock and did no in-tx
 *      re-check, so a plan soft-deleted after the snapshot still received
 *      the member. The race is pinned deterministically: the plan row is
 *      soft-deleted in the DB while `getPlan` hands back the stale live
 *      snapshot — exactly what the use case sees when `softDeleteGuarded`
 *      commits between its read and its write.
 *   #5 an individual (legal entity type) is refused on a company-only plan
 *      unless an override reason is given.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { createMember } from '@/modules/members';
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

function input(planId: string, extra: Record<string, unknown> = {}) {
  return {
    company_name: `Guard Co ${randomUUID().slice(0, 8)}`,
    country: 'TH',
    plan_id: planId,
    plan_year: 2026,
    primary_contact: {
      first_name: 'Anna',
      last_name: 'Andersson',
      email: `anna-${randomUUID().slice(0, 8)}@example.com`,
      preferred_language: 'en' as const,
    },
    ...extra,
  };
}

describe('createMember plan guards (126)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  const livePlan = 'guard-live';
  const doomedPlan = 'guard-doomed';

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
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
      for (const planId of [livePlan, doomedPlan]) {
        await tx.insert(membershipPlans).values({
          tenantId: tenant.ctx.slug,
          planId,
          planYear: 2026,
          planName: { en: planId },
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
          isActive: false,
          createdBy: user.userId,
          updatedBy: user.userId,
        });
      }
    });
  });

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('#8 refuses a plan soft-deleted after the pre-tx snapshot — no member row', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    // Snapshot first (live), then the concurrent soft-delete commits.
    const snapshot = await deps.plans.getPlan(tenant.ctx, doomedPlan as never, 2026);
    expect(snapshot.ok && snapshot.value.isSoftDeleted).toBe(false);
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(membershipPlans.planId, doomedPlan), eq(membershipPlans.planYear, 2026))),
    );
    const staleDeps = { ...deps, plans: { ...deps.plans, getPlan: async () => snapshot } };

    const body = input(doomedPlan);
    const r = await createMember(
      body,
      { actorUserId: user.userId, requestId: `rq-126-${Date.now()}` },
      staleDeps,
    );
    expect(r).toEqual({ ok: false, error: { type: 'plan_not_found' } });

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx.select().from(members).where(eq(members.companyName, body.company_name)),
    );
    expect(rows).toHaveLength(0);
  });

  it('#5 refuses an individual on a company-only plan, and an override lets it through', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const refused = await createMember(
      input(livePlan, { legal_entity_type: 'individual' }),
      { actorUserId: user.userId, requestId: `rq-126-ind-${Date.now()}` },
      deps,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.type).toBe('member_type_out_of_scope');

    const overridden = await createMember(
      input(livePlan, {
        legal_entity_type: 'individual',
        override_reason_code: 'board_approved',
        override_reason_note: 'AGM decision',
      }),
      { actorUserId: user.userId, requestId: `rq-126-ovr-${Date.now()}` },
      deps,
    );
    expect(overridden.ok, JSON.stringify(overridden)).toBe(true);
  });
});

