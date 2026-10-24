/**
 * 126 #6 — a soft-deleted plan cannot be edited.
 *
 * `findOne` deliberately returns soft-deleted rows (undelete needs them), and
 * neither `updatePlan` nor the repo UPDATE filtered on `deleted_at` — unlike
 * `setActive`. A PATCH from a stale tab or a crafted request therefore
 * changed a deleted plan's fee, and a later undelete restored edits no one
 * saw in the live list.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { softDeletePlan } from '@/modules/plans/application/soft-delete-plan';
import { updatePlan } from '@/modules/plans/application/update-plan';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { ClockPort, PlanDraftInput } from '@/modules/plans/application/ports';
import { createActiveTestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 0,
  website_page_type: null,
  homepage_logo_category: null,
  directory_listing_size: null,
  event_discount_scope: 'none',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: false,
  business_referrals: false,
  tailor_made_services: false,
  partnership: null,
};

const clock: ClockPort = {
  now: () => new Date('2027-06-15T00:00:00Z'),
  currentYear: () => 2027,
};

describe('Integration: updatePlan on a soft-deleted plan (126 #6)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('returns not_found and leaves the deleted row unchanged', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, {
      plan_id: 'premium',
      plan_year: 2027,
      plan_name: { en: 'Premium' },
      description: { en: 'Test description' },
      sort_order: 10,
      plan_category: 'corporate',
      member_type_scope: 'company',
      annual_fee_minor_units: 3_600_000,
      includes_corporate_plan_id: null,
      min_turnover_minor_units: null,
      max_turnover_minor_units: null,
      max_duration_years: null,
      max_member_age: null,
      benefit_matrix: MATRIX,
      isActive: false,
      createdBy: user.userId,
      updatedBy: user.userId,
    } as PlanDraftInput);

    const base = {
      planId: asPlanSlug('premium'),
      year: asPlanYear(2027),
      actorUserId: user.userId,
      sourceIp: null,
    };
    const deleted = await softDeletePlan(
      { ...base, requestId: 'req-126-del', idempotencyKey: 'idem-126-del' },
      { tenant: tenant.ctx, planRepo, audit: planAuditAdapter, clock },
    );
    expect(deleted.ok).toBe(true);

    const result = await updatePlan(
      {
        ...base,
        patch: { annual_fee_minor_units: 9_900_000 },
        requestId: 'req-126-upd',
        idempotencyKey: 'idem-126-upd',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock,
        members: { countActivePlanMembers: async () => 0 },
      },
    );
    expect(result).toEqual({ ok: false, error: { type: 'not_found' } });

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ fee: membershipPlans.annualFeeMinorUnits })
        .from(membershipPlans)
        .where(and(eq(membershipPlans.planId, 'premium'), eq(membershipPlans.planYear, 2027))),
    );
    expect(rows[0]?.fee).toBe(3_600_000);
  });
});
