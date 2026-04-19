/**
 * T125 — Integration: soft-delete plan with attached members (US4 FR-010).
 *
 * Critique P7 — F2 does not ship a `members` table, so the
 * `plan_has_active_members` refusal path cannot be covered end-to-end
 * with real data in F2. Instead we swap in a stub
 * `MemberAttachmentChecker` that returns a configurable count, so we
 * can exercise both branches of `softDeletePlan`:
 *
 *   Scenario 1 — stub returns 3 → soft-delete refuses with
 *                `{type: 'has_active_members', count: 3}`.
 *   Scenario 2 — stub returns 0 → soft-delete succeeds, `deleted_at` set.
 *
 * The real Drizzle-backed checker lands in F3 alongside the `members`
 * table; the Application-layer contract does not change — F3 just
 * swaps the Infrastructure implementation through the same port.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { softDeletePlan } from '@/modules/plans/application/soft-delete-plan';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type {
  ClockPort,
  MemberAttachmentChecker,
  PlanDraftInput,
} from '@/modules/plans/application/ports';
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

const currentYearClock: ClockPort = {
  now: () => new Date('2027-06-15T00:00:00Z'),
  currentYear: () => 2027,
};

function seed(userId: string): PlanDraftInput {
  return {
    plan_id: 'premium',
    plan_year: 2027,
    plan_name: { en: 'Premium' },
    description: { en: '' },
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
    isActive: false, // already-inactive per FR-009 precondition
    createdBy: userId,
    updatedBy: userId,
  } as PlanDraftInput;
}

function makeFakeChecker(count: number): MemberAttachmentChecker {
  return {
    async countActivePlanMembers() {
      return count;
    },
  };
}


describe('Integration: soft-delete with attached members (T125)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('Scenario 1 — stub checker returns 3 → refuses with has_active_members', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seed(user.userId));

    const result = await softDeletePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-del-1',
        sourceIp: null,
        idempotencyKey: 'idem-del-1',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: currentYearClock,
        members: makeFakeChecker(3),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.type).toBe('has_active_members');
    if (result.error.type === 'has_active_members') {
      expect(result.error.count).toBe(3);
    }

    // Confirm the plan was NOT deleted
    const reloaded = await planRepo.findOne(
      tenant.ctx,
      asPlanSlug('premium'),
      asPlanYear(2027),
    );
    expect(reloaded?.deleted_at).toBeNull();
  });

  it('Scenario 2 — stub checker returns 0 → soft-delete succeeds', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seed(user.userId));

    const result = await softDeletePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-del-2',
        sourceIp: null,
        idempotencyKey: 'idem-del-2',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: currentYearClock,
        members: makeFakeChecker(0),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.deleted_at).not.toBeNull();

    // Row now soft-deleted
    const reloaded = await planRepo.findOne(
      tenant.ctx,
      asPlanSlug('premium'),
      asPlanYear(2027),
    );
    expect(reloaded?.deleted_at).not.toBeNull();
  });
});
