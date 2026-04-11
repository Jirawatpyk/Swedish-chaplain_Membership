/**
 * T141 — Integration: currency-code immutability guard vs live Neon
 * (critique R1).
 *
 * Scenario 1: seed 3 plans for the tenant → PATCH `{currency_code: 'JPY'}`
 *             → err `currency_code_immutable_in_f2` with
 *             `non_deleted_plan_count: 3`; fee config row UNCHANGED.
 *
 * Scenario 2: soft-delete all 3 plans → PATCH `{currency_code: 'JPY'}`
 *             → succeeds (proves the guard is per-plan-count, not absolute);
 *             fee config updates to JPY.
 *
 * Both scenarios run against the real `PlanRepo.countActiveForTenant`
 * to prove the guard and the repo agree on "non-deleted" semantics.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { feeConfigRepo } from '@/modules/plans/infrastructure/db/fee-config-repo';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { stubMemberAttachmentChecker } from '@/modules/plans/infrastructure/members/stub-member-attachment-checker';
import { updateFeeConfig } from '@/modules/plans/application/update-fee-config';
import { softDeletePlan } from '@/modules/plans/application/soft-delete-plan';
import type {
  ClockPort,
  PlanDraftInput,
} from '@/modules/plans/application/ports';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

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

function seed(userId: string, planId: string): PlanDraftInput {
  return {
    plan_id: planId,
    plan_year: 2027,
    plan_name: { en: planId },
    description: { en: '' },
    sort_order: 10,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 1_000_000,
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

function buildDeps(tenant: TestTenant) {
  return {
    tenant: tenant.ctx,
    planRepo,
    feeConfigRepo,
    audit: planAuditAdapter,
    clock,
    members: stubMemberAttachmentChecker,
  };
}

describe('Integration: fee-config currency immutability vs live Neon (T141, critique R1)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('rejects currency change while 3 non-deleted plans exist', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });
    await planRepo.insert(tenant.ctx, seed(user.userId, 'gold'));
    await planRepo.insert(tenant.ctx, seed(user.userId, 'silver'));
    await planRepo.insert(tenant.ctx, seed(user.userId, 'bronze'));

    const result = await updateFeeConfig(
      {
        patch: { currency_code: 'JPY' },
        actorUserId: user.userId,
        requestId: 'req-fee-currency-1',
        sourceIp: null,
        idempotencyKey: 'idem-fee-currency-1',
      },
      buildDeps(tenant),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.type).toBe('currency_code_immutable_in_f2');
    if (result.error.type !== 'currency_code_immutable_in_f2') return;
    expect(result.error.current_currency_code).toBe('THB');
    expect(result.error.attempted_currency_code).toBe('JPY');
    expect(result.error.non_deleted_plan_count).toBe(3);

    // Fee config row unchanged
    const fresh = await feeConfigRepo.findByTenant(tenant.ctx);
    expect(fresh!.currency_code).toBe('THB');
  });

  it('allows currency change once all plans are soft-deleted', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100_000,
      updated_by: user.userId,
    });
    await planRepo.insert(tenant.ctx, seed(user.userId, 'gold'));
    await planRepo.insert(tenant.ctx, seed(user.userId, 'silver'));
    await planRepo.insert(tenant.ctx, seed(user.userId, 'bronze'));

    // Soft-delete all three
    for (const planId of ['gold', 'silver', 'bronze']) {
      const soft = await softDeletePlan(
        {
          planId: asPlanSlug(planId),
          year: asPlanYear(2027),
          actorUserId: user.userId,
          requestId: `req-soft-${planId}`,
          sourceIp: null,
          idempotencyKey: `idem-soft-${planId}`,
        },
        buildDeps(tenant),
      );
      expect(soft.ok).toBe(true);
    }

    const result = await updateFeeConfig(
      {
        patch: { currency_code: 'JPY' },
        actorUserId: user.userId,
        requestId: 'req-fee-currency-2',
        sourceIp: null,
        idempotencyKey: 'idem-fee-currency-2',
      },
      buildDeps(tenant),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.currency_code).toBe('JPY');

    // Verify repo persisted
    const fresh = await feeConfigRepo.findByTenant(tenant.ctx);
    expect(fresh!.currency_code).toBe('JPY');
  });
});
