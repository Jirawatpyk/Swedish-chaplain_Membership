/**
 * T125 — Integration: soft-delete plan with attached members (US4 FR-010).
 *
 * W0-02 update: the former two-step `MemberAttachmentChecker` + `softDelete`
 * pattern has been replaced by the atomic `planRepo.softDeleteGuarded` method.
 * `SoftDeletePlanDeps` no longer carries `members`.
 *
 * Scenarios exercise the `softDeletePlan` use case with a real Neon DB
 * (the advisory-lock + count + delete atomicity is tested by the dedicated
 * `soft-delete-toctou-advisory-lock.test.ts` integration test).
 *
 *   Scenario 1 — 1 active F3 member attached → refuses with has_active_members.
 *   Scenario 2 — 0 members attached → soft-delete succeeds.
 *   Scenario 3 — 2 real F3 members (1 active, 1 inactive) attached → refuses
 *                with count=2 (archived rows deliberately excluded).
 *   Scenario 4 — 1 F3 member with status='archived' → soft-delete succeeds
 *                (archived members don't block).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { softDeletePlan } from '@/modules/plans/application/soft-delete-plan';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import { members } from '@/modules/members/infrastructure/db/schema-members';
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

const currentYearClock: ClockPort = {
  now: () => new Date('2027-06-15T00:00:00Z'),
  currentYear: () => 2027,
};

function seed(userId: string): PlanDraftInput {
  return {
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
    isActive: false, // already-inactive per FR-009 precondition
    createdBy: userId,
    updatedBy: userId,
  } as PlanDraftInput;
}


describe('Integration: soft-delete with attached members (T125)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  // Helper to seed an F3 member row directly
  async function seedMember(
    tenantSlug: string,
    planId: string,
    planYear: number,
    status: 'active' | 'inactive' | 'archived',
  ): Promise<void> {
    await runInTenant({ slug: tenantSlug } as never, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenantSlug,
        memberId: randomUUID(),
        companyName: `Test Co ${status}`,
        country: 'TH',
        planId,
        planYear,
        registrationFeePaid: false,
        status,
        // R6 QA fix — F3 schema enforces a status↔archived_at CHECK
        // constraint (`members_archived_at_iff_archived`). Setting
        // status='archived' WITHOUT archived_at violates the invariant
        // and the row is rejected with PostgresError 23514. Pair the
        // archived flag with a current timestamp; for non-archived
        // statuses leave archived_at as the column default (null).
        ...(status === 'archived' ? { archivedAt: new Date() } : {}),
      });
    });
  }

  it('Scenario 1 — 1 active member → refuses with has_active_members', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seed(user.userId));
    await seedMember(tenant.ctx.slug, 'premium', 2027, 'active');

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
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.type).toBe('has_active_members');
    if (result.error.type === 'has_active_members') {
      expect(result.error.count).toBeGreaterThanOrEqual(1);
    }

    // Confirm the plan was NOT deleted
    const reloaded = await planRepo.findOne(
      tenant.ctx,
      asPlanSlug('premium'),
      asPlanYear(2027),
    );
    expect(reloaded?.deleted_at).toBeNull();
  });

  it('Scenario 2 — 0 members attached → soft-delete succeeds', async () => {
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

  // -------------------------------------------------------------------
  // Scenarios 3 + 4 — real F3 members (post-ship R6 C1, closes I6)
  // -------------------------------------------------------------------

  it('Scenario 3 — 2 real F3 members (active + inactive) → refuses with count=2', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seed(user.userId));
    await seedMember(tenant.ctx.slug, 'premium', 2027, 'active');
    await seedMember(tenant.ctx.slug, 'premium', 2027, 'inactive');

    const result = await softDeletePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-del-3',
        sourceIp: null,
        idempotencyKey: 'idem-del-3',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: currentYearClock,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.type).toBe('has_active_members');
    if (result.error.type === 'has_active_members') {
      expect(result.error.count).toBe(2);
    }
  });

  it('Scenario 4 — 1 archived F3 member → soft-delete succeeds (archived excluded)', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    await planRepo.insert(tenant.ctx, seed(user.userId));
    await seedMember(tenant.ctx.slug, 'premium', 2027, 'archived');

    const result = await softDeletePlan(
      {
        planId: asPlanSlug('premium'),
        year: asPlanYear(2027),
        actorUserId: user.userId,
        requestId: 'req-del-4',
        sourceIp: null,
        idempotencyKey: 'idem-del-4',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: currentYearClock,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.deleted_at).not.toBeNull();
  });
});
