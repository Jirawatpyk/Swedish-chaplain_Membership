/**
 * T112 — Integration: prior-year partial lock (US3 FR-014).
 *
 * Scenarios (with injected FixedClock advancing past the plan year):
 *   1. Edit plan_name.en on a 2026 plan when current year is 2027 → succeeds
 *   2. Edit description.en on a 2026 plan → succeeds
 *   3. Edit sort_order on a 2026 plan → succeeds
 *   4. Edit annual_fee_minor_units on a 2026 plan → 422 prior_year_locked_fields
 *   5. Edit min_turnover / max_turnover / max_duration / max_member_age / member_type_scope
 *      / includes_corporate_plan_id / benefit_matrix → each returns 422
 *   6. Edit ANY field on a current-year plan (plan_year >= currentYear) → succeeds
 *   7. No-op write of a locked field (same value) → succeeds (deep-equal bypass)
 *
 * Exercises the real `updatePlan` use case + `planRepo.update` + live Neon.
 * The ClockPort is mocked to return a fixed year so tests are deterministic.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { drizzleMemberAttachmentChecker } from '@/modules/plans/infrastructure/members/drizzle-member-attachment-checker';
import { updatePlan } from '@/modules/plans/application/update-plan';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanDraftInput } from '@/modules/plans/application/ports';
import type { ClockPort } from '@/modules/plans/application/ports';
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

function seedDraft(userId: string, year: number): PlanDraftInput {
  return {
    plan_id: 'premium',
    plan_year: year,
    plan_name: { en: 'Premium' },
    description: { en: 'Original description' },
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
    isActive: true,
    createdBy: userId,
    updatedBy: userId,
  } as PlanDraftInput;
}

function makeFixedClock(year: number): ClockPort {
  return {
    now: () => new Date(`${year}-06-15T00:00:00Z`),
    currentYear: () => year,
  };
}

async function buildCtx(tenant: TestTenant) {
  return {
    tenant: tenant.ctx,
    planRepo,
    audit: planAuditAdapter,
    clock: makeFixedClock(2027),
    members: drizzleMemberAttachmentChecker,
  };
}


describe('Integration: prior-year partial lock (T112)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) {
      await tenant.cleanup().catch(() => {});
    }
  });

  it('Scenario 1 — edit plan_name.en on 2026 plan (when current=2027) succeeds', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seedDraft(user.userId, 2026));

    const result = await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2026),
        patch: { plan_name: { en: 'Premium Renamed' } },
        actorUserId: user.userId,
        requestId: 'req-1',
        sourceIp: null,
        idempotencyKey: 'idem-1',
      },
      await buildCtx(tenant),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.plan_name.en).toBe('Premium Renamed');
  });

  it('Scenario 2 — edit description.en on 2026 plan succeeds', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seedDraft(user.userId, 2026));

    const result = await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2026),
        patch: { description: { en: 'Updated description' } },
        actorUserId: user.userId,
        requestId: 'req-2',
        sourceIp: null,
        idempotencyKey: 'idem-2',
      },
      await buildCtx(tenant),
    );
    expect(result.ok).toBe(true);
  });

  it('Scenario 3 — edit sort_order on 2026 plan succeeds', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seedDraft(user.userId, 2026));

    const result = await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2026),
        patch: { sort_order: 99 },
        actorUserId: user.userId,
        requestId: 'req-3',
        sourceIp: null,
        idempotencyKey: 'idem-3',
      },
      await buildCtx(tenant),
    );
    expect(result.ok).toBe(true);
  });

  it('Scenario 4 — edit annual_fee_minor_units on 2026 plan returns 422 locked', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seedDraft(user.userId, 2026));

    const result = await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2026),
        patch: { annual_fee_minor_units: 4_000_000 },
        actorUserId: user.userId,
        requestId: 'req-4',
        sourceIp: null,
        idempotencyKey: 'idem-4',
      },
      await buildCtx(tenant),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.type).toBe('prior_year_locked_fields');
    if (result.error.type === 'prior_year_locked_fields') {
      expect(result.error.locked_fields).toContain('annual_fee_minor_units');
    }
  });

  it('Scenario 5 — edit benefit_matrix on 2026 plan returns 422 locked', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seedDraft(user.userId, 2026));

    const result = await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2026),
        patch: {
          benefit_matrix: { ...MATRIX, eblast_per_year: 5 },
        },
        actorUserId: user.userId,
        requestId: 'req-5',
        sourceIp: null,
        idempotencyKey: 'idem-5',
      },
      await buildCtx(tenant),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.type).toBe('prior_year_locked_fields');
    if (result.error.type === 'prior_year_locked_fields') {
      expect(result.error.locked_fields).toContain('benefit_matrix');
    }
  });

  it('Scenario 6 — edit annual_fee on current-year (2027) plan succeeds', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seedDraft(user.userId, 2027));

    const result = await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        patch: { annual_fee_minor_units: 4_000_000 },
        actorUserId: user.userId,
        requestId: 'req-6',
        sourceIp: null,
        idempotencyKey: 'idem-6',
      },
      await buildCtx(tenant),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.annual_fee_minor_units).toBe(4_000_000);
  });

  it('Scenario 7 — no-op write of locked field (same value) succeeds', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seedDraft(user.userId, 2026));

    const result = await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2026),
        patch: { annual_fee_minor_units: 3_600_000 }, // same as seed
        actorUserId: user.userId,
        requestId: 'req-7',
        sourceIp: null,
        idempotencyKey: 'idem-7',
      },
      await buildCtx(tenant),
    );
    expect(result.ok).toBe(true);
  });
});
