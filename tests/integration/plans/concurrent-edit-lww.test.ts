/**
 * T113 — Integration: concurrent edit last-write-wins (US3).
 *
 * Two admins edit the same current-year plan simultaneously; the
 * later commit wins (LWW) and the plan's final `updated_by` reflects
 * the winner. Earlier session's edits on distinct fields are preserved
 * because SQL UPDATE ... SET only touches the columns named in the
 * patch — Drizzle's `update().set(partialValues)` already honours
 * this per the repo implementation.
 *
 * Scenarios:
 *   1. Admin A changes plan_name.en while Admin B changes sort_order
 *      in overlapping time → both survive (different fields)
 *   2. Admin A and Admin B both change plan_name.en → the later write
 *      wins, the earlier one is overwritten (last-write-wins)
 *
 * Note: F2 does NOT implement optimistic locking via updated_at CAS
 * per research.md § 8 decision — LWW is acceptable for the low-
 * concurrency admin editing workflow. F3+ will revisit when bulk
 * actions + multiple concurrent admins become the norm.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { drizzleMemberAttachmentChecker } from '@/modules/plans/infrastructure/members/drizzle-member-attachment-checker';
import { updatePlan } from '@/modules/plans/application/update-plan';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanDraftInput, ClockPort } from '@/modules/plans/application/ports';
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

const currentYearClock: ClockPort = {
  now: () => new Date('2027-06-15T00:00:00Z'),
  currentYear: () => 2027,
};

function seed(userId: string): PlanDraftInput {
  return {
    plan_id: 'premium',
    plan_year: 2027,
    plan_name: { en: 'Original' },
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
    isActive: true,
    createdBy: userId,
    updatedBy: userId,
  } as PlanDraftInput;
}

describe('Integration: concurrent edit LWW (T113)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('Scenario 1 — non-overlapping edits both survive', async () => {
    const adminA = await createActiveTestUser('admin');
    const adminB = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await planRepo.insert(tenant.ctx, seed(adminA.userId));

    // Launch both edits concurrently
    const [resA, resB] = await Promise.all([
      updatePlan(
        {
          planId: asPlanSlug('premium'),
          year: asPlanYear(2027),
          patch: { plan_name: { en: 'Renamed by A' } },
          actorUserId: adminA.userId,
          requestId: 'req-a',
          sourceIp: null,
          idempotencyKey: 'idem-a',
        },
        {
          tenant: tenant.ctx,
          planRepo,
          audit: planAuditAdapter,
          clock: currentYearClock,
          members: drizzleMemberAttachmentChecker,
        },
      ),
      updatePlan(
        {
          planId: asPlanSlug('premium'),
          year: asPlanYear(2027),
          patch: { sort_order: 99 },
          actorUserId: adminB.userId,
          requestId: 'req-b',
          sourceIp: null,
          idempotencyKey: 'idem-b',
        },
        {
          tenant: tenant.ctx,
          planRepo,
          audit: planAuditAdapter,
          clock: currentYearClock,
          members: drizzleMemberAttachmentChecker,
        },
      ),
    ]);

    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    const final = await planRepo.findOne(
      tenant.ctx,
      asPlanSlug('premium'),
      asPlanYear(2027),
    );
    expect(final).toBeDefined();
    expect(final?.plan_name.en).toBe('Renamed by A');
    expect(final?.sort_order).toBe(99);
  });

  it('Scenario 2 — overlapping edits last-write-wins', async () => {
    const adminA = await createActiveTestUser('admin');
    const adminB = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await planRepo.insert(tenant.ctx, seed(adminA.userId));

    // Sequential writes — B is the last writer
    await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        patch: { plan_name: { en: 'A wrote first' } },
        actorUserId: adminA.userId,
        requestId: 'req-a',
        sourceIp: null,
        idempotencyKey: 'idem-a',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: currentYearClock,
        members: drizzleMemberAttachmentChecker,
      },
    );
    await updatePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        patch: { plan_name: { en: 'B wrote second' } },
        actorUserId: adminB.userId,
        requestId: 'req-b',
        sourceIp: null,
        idempotencyKey: 'idem-b',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: currentYearClock,
        members: drizzleMemberAttachmentChecker,
      },
    );

    const final = await planRepo.findOne(
      tenant.ctx,
      asPlanSlug('premium'),
      asPlanYear(2027),
    );
    expect(final?.plan_name.en).toBe('B wrote second');
    expect(final?.updated_by).toBe(adminB.userId);
  });
});
