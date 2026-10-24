/**
 * 126 #7 — every plans mutation writes its audit row in the SAME tx as the
 * state change, so an audit failure rolls the change back.
 *
 * Before 126 each use case committed the write in the repo's own
 * `runInTenant` and then appended the audit in a separate call: an audit
 * failure returned `audit_failed` AFTER the row had changed, and a client
 * retry hit the empty-diff short-circuit — the change was never audited.
 * Constitution VIII: "Any database operation that mutates more than one row
 * or crosses aggregates MUST run inside a transaction."
 *
 * Each case drives the use case with an audit port that always fails and
 * reads the row back directly: it must be unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { err } from '@/lib/result';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { createPlan } from '@/modules/plans/application/create-plan';
import { updatePlan } from '@/modules/plans/application/update-plan';
import { setPlanActive } from '@/modules/plans/application/set-plan-active';
import { softDeletePlan } from '@/modules/plans/application/soft-delete-plan';
import { undeletePlan } from '@/modules/plans/application/undelete-plan';
import { clonePlansToYear } from '@/modules/plans/application/clone-plans-to-year';
import { scheduleNextRenewalPlanChange } from '@/modules/plans/application/schedule-next-renewal-plan-change';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { AuditPort, ClockPort, PlanDraftInput } from '@/modules/plans/application/ports';
import { createActiveTestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { seedMemberAndRenewalCycle } from '../helpers/seed-renewal-cycle';

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

const failure = err({ type: 'persist_failed' as const, message: 'simulated audit outage (126)' });
const failingAudit = {
  record: async () => failure,
  recordInTx: async () => failure,
} as unknown as AuditPort;

function draft(userId: string, overrides: Partial<PlanDraftInput> = {}): PlanDraftInput {
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
    isActive: false,
    createdBy: userId,
    updatedBy: userId,
    ...overrides,
  } as PlanDraftInput;
}

describe('Integration: plans audit is in the write tx (126 #7)', () => {
  let tenant: TestTenant;
  let userId: string;

  const meta = (n: string) => ({
    actorUserId: userId,
    requestId: `req-126-${n}`,
    sourceIp: null,
    idempotencyKey: `idem-126-${n}`,
  });
  const key = { planId: asPlanSlug('premium'), year: asPlanYear(2027) };
  const deps = () => ({
    tenant: tenant.ctx,
    planRepo,
    audit: failingAudit,
    clock,
    members: { countActivePlanMembers: async () => 0 },
  });
  async function row(planId = 'premium', year = 2027) {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(and(eq(membershipPlans.planId, planId), eq(membershipPlans.planYear, year))),
    );
    return rows[0];
  }

  async function setup() {
    userId = (await createActiveTestUser('admin')).userId;
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
  }

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  it('createPlan: no plan row', async () => {
    await setup();
    const { createdBy: _c, updatedBy: _u, isActive: _a, ...input } = draft(userId);
    const r = await createPlan({ input, ...meta('create') } as never, deps());
    expect(r.ok).toBe(false);
    expect(await row()).toBeUndefined();
  });

  it('updatePlan: fee unchanged', async () => {
    await setup();
    await planRepo.insert(tenant.ctx, draft(userId));
    const r = await updatePlan(
      { ...key, patch: { annual_fee_minor_units: 9_900_000 }, ...meta('update') },
      deps(),
    );
    expect(r.ok).toBe(false);
    expect((await row())?.annualFeeMinorUnits).toBe(3_600_000);
  });

  it('setPlanActive: still inactive', async () => {
    await setup();
    await planRepo.insert(tenant.ctx, draft(userId));
    const r = await setPlanActive({ ...key, ...meta('activate') }, deps(), true);
    expect(r.ok).toBe(false);
    expect((await row())?.isActive).toBe(false);
  });

  it('softDeletePlan: not deleted', async () => {
    await setup();
    await planRepo.insert(tenant.ctx, draft(userId));
    const r = await softDeletePlan({ ...key, ...meta('delete') }, deps());
    expect(r.ok).toBe(false);
    expect((await row())?.deletedAt).toBeNull();
  });

  it('undeletePlan: still deleted', async () => {
    await setup();
    await planRepo.insert(tenant.ctx, draft(userId));
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({ deletedAt: new Date('2027-01-01T00:00:00Z') })
        .where(eq(membershipPlans.planId, 'premium')),
    );
    const r = await undeletePlan({ ...key, ...meta('undelete') }, deps());
    expect(r.ok).toBe(false);
    expect((await row())?.deletedAt).not.toBeNull();
  });

  it('clonePlansToYear: target year stays empty', async () => {
    await setup();
    await planRepo.insert(tenant.ctx, draft(userId));
    const r = await clonePlansToYear(
      {
        sourceYear: asPlanYear(2027),
        targetYear: asPlanYear(2028),
        activateCloned: false,
        ...meta('clone'),
      } as never,
      deps(),
    );
    expect(r.ok).toBe(false);
    expect(await row('premium', 2028)).toBeUndefined();
  });

  it('scheduleNextRenewalPlanChange: no pending row', async () => {
    await setup();
    const { memberId, cycleId, ownerCleanup } = await seedMemberAndRenewalCycle({
      tenant: tenant.ctx,
    });
    try {
      const r = await scheduleNextRenewalPlanChange(
        {
          tenant: tenant.ctx,
          repo: drizzleScheduledPlanChangeRepo,
          audit: failingAudit,
          actorUserId: userId,
          requestId: 'req-126-schedule',
          sourceIp: null,
        },
        {
          memberId,
          effectiveAtCycleId: cycleId,
          fromPlanId: 'corporate-regular',
          toPlanId: 'corporate-premier',
          scheduledByUserId: userId,
        },
      );
      expect(r.ok).toBe(false);
      const rows = await runInTenant(tenant.ctx, (tx) =>
        tx.select().from(scheduledPlanChanges).where(eq(scheduledPlanChanges.memberId, memberId)),
      );
      expect(rows).toHaveLength(0);
    } finally {
      await ownerCleanup();
    }
  });
});
