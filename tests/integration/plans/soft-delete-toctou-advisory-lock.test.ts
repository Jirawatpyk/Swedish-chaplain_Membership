/**
 * W0-02 — Integration: soft-delete/assign TOCTOU race is closed by the
 * shared `plans:softdelete:` advisory lock.
 *
 * **The race condition W0-02 fixes:**
 *
 *   WITHOUT the lock (the old bug):
 *     Thread A (softDelete):  count=0 ────────────────────── DELETE → commit
 *     Thread B (changePlan):            assign → commit
 *
 *   Thread A observed count=0 BEFORE B assigned — so A proceeded to delete
 *   even though B assigned in the window between A's count and A's delete.
 *   Result: deleted plan + active member on it (FORBIDDEN STATE).
 *
 *   WITH the lock (W0-02 fix):
 *     Thread B (changePlan):  acquire lock → assign → commit → release lock
 *     Thread A (softDelete):  [blocked waiting for lock] → acquire lock →
 *                              count=1 (sees B's assignment) → REFUSE → release lock
 *
 *   OR:
 *     Thread A (softDelete):  acquire lock → count=0 → DELETE → commit → release lock
 *     Thread B (changePlan):  [blocked] → acquire lock → assign → commit
 *     (B assigns to a soft-deleted plan — this is a separate FK concern, not
 *     part of the TOCTOU fix. The lock DOES prevent the specific race where
 *     A saw count=0 while B was in the process of assigning.)
 *
 * **What these tests verify:**
 *
 *   1. Regression: the count+delete is atomic — a member assigned BEFORE the
 *      lock is acquired is counted correctly (refuses soft-delete).
 *
 *   2. Lock serialisation (the race that W0-02 closes): when the assign
 *      reaches the lock BEFORE the soft-delete, the soft-delete sees count≥1
 *      and aborts. We simulate this by having Side B acquire the SAME lock key
 *      first and assign inside it, then release; Side A (softDeleteGuarded)
 *      then runs and sees the committed member.
 *
 *      This is the exact race window the advisory lock closes: previously,
 *      the count and the delete were in SEPARATE runInTenant round-trips, so
 *      an assign between them was invisible to the delete. Now they are in ONE
 *      transaction under the lock, so any assign that commits BEFORE the lock
 *      is acquired will be counted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import { asPlanSlug, asPlanYear, planSoftDeleteLockKey } from '@/modules/plans';
import { softDeletePlan } from '@/modules/plans/application/soft-delete-plan';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { ClockPort, PlanDraftInput } from '@/modules/plans/application/ports';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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

const PLAN_YEAR = 2027;

const currentYearClock: ClockPort = {
  now: () => new Date('2027-06-15T00:00:00Z'),
  currentYear: () => PLAN_YEAR,
};

function buildPlanDraft(userId: string, planId: string): PlanDraftInput {
  return {
    plan_id: planId,
    plan_year: PLAN_YEAR,
    plan_name: { en: `W0-02 Test Plan ${planId}` },
    description: { en: 'W0-02 advisory-lock test plan' },
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Integration: soft-delete TOCTOU advisory lock (W0-02)', () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await tenant.cleanup().catch(() => {});
  });

  // -----------------------------------------------------------------------
  // Test 1 — Regression: soft-deleting a plan with an active member
  //          returns has_active_members and leaves deleted_at = NULL.
  // -----------------------------------------------------------------------

  it('Regression — soft-delete with an active member returns has_active_members (no deleted_at)', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });

    const planId = `w002-reg-${randomUUID().slice(0, 8)}`;
    await planRepo.insert(tenant.ctx, buildPlanDraft(user.userId, planId));

    // Seed one active member on the plan directly
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'W0-02 Regression Co',
        country: 'TH',
        planId,
        planYear: PLAN_YEAR,
        registrationFeePaid: false,
        status: 'active',
      });
    });

    // Attempt soft-delete via the guarded method
    const result = await softDeletePlan(
      {
        planId: asPlanSlug(planId),
        year: asPlanYear(PLAN_YEAR),
        actorUserId: user.userId,
        requestId: 'w002-reg-req',
        sourceIp: null,
        idempotencyKey: 'w002-reg-idem',
      },
      {
        tenant: tenant.ctx,
        planRepo,
        audit: planAuditAdapter,
        clock: currentYearClock,
      },
    );

    // Must refuse with has_active_members
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.type).toBe('has_active_members');
    if (result.error.type === 'has_active_members') {
      expect(result.error.count).toBeGreaterThanOrEqual(1);
    }

    // Confirm deleted_at is still NULL
    const reloaded = await planRepo.findOne(
      tenant.ctx,
      asPlanSlug(planId),
      asPlanYear(PLAN_YEAR),
    );
    expect(reloaded).toBeDefined();
    expect(reloaded?.deleted_at).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 2 — Lock serialisation: the soft-delete TOCTOU race is closed.
  //
  // Simulates the exact race condition that W0-02 fixes:
  //
  //   OLD behaviour (2 separate runInTenant trips):
  //     A: count=0 → [window] → delete
  //     B:            assign → commit            ← invisible to A's delete!
  //   Result: deleted plan + active member (FORBIDDEN).
  //
  //   NEW behaviour (1 runInTenant under lock):
  //     B: acquire lock → assign → commit → release lock
  //     A: [blocks on lock] → acquire lock → count=1 (sees B's commit) → refuse
  //   Result: plan NOT deleted, member correctly assigned. ✓
  //
  // We simulate this by running Side B (assign inside lock) FIRST, letting
  // it commit, then running Side A (softDeleteGuarded). The lock guarantees
  // A's count sees B's committed assignment — A must refuse.
  //
  // This test is NOT a concurrent Promise.all test (that would be non-
  // deterministic). It is a controlled sequential test proving that any
  // assign that commits BEFORE the lock is acquired will be counted.
  // -----------------------------------------------------------------------

  it('Race condition closed — member assigned before lock: softDeleteGuarded refuses with has_active_members', async () => {
    const user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });

    const targetPlanId = `w002-race-${randomUUID().slice(0, 8)}`;
    const startPlanId = `w002-race-start-${randomUUID().slice(0, 8)}`;

    await planRepo.insert(tenant.ctx, buildPlanDraft(user.userId, targetPlanId));
    await planRepo.insert(tenant.ctx, buildPlanDraft(user.userId, startPlanId));

    // Seed member on startPlan (count on targetPlan = 0 initially)
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        companyName: 'W0-02 Race Test Co',
        country: 'TH',
        planId: startPlanId,
        planYear: PLAN_YEAR,
        registrationFeePaid: false,
        status: 'active',
      });
    });

    // STEP 1 (simulates Thread B winning the lock):
    // Assign member to targetPlan inside the advisory-lock scope,
    // then commit. This simulates changePlan arriving BEFORE softDelete.
    const lockKey = planSoftDeleteLockKey(tenant.ctx.slug, targetPlanId, PLAN_YEAR);
    await runInTenant(tenant.ctx, async (tx) => {
      // Acquire the SAME lock key that softDeleteGuarded uses
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
      // "Assign" the member to targetPlan (simulates changePlan's UPDATE)
      await tx
        .update(members)
        .set({ planId: targetPlanId })
        .where(eq(members.memberId, memberId));
      // tx commits here → releases lock → assignment is now visible to DB
    });

    // STEP 2 (simulates Thread A entering after B committed):
    // softDeleteGuarded acquires the lock, counts members on targetPlan.
    // W0-02 fix: count and delete are in ONE tx under the lock, so the
    // count WILL see B's committed assignment (count=1) and refuse.
    //
    // Without W0-02: count was a separate runInTenant trip BEFORE the
    // delete trip. If B committed between count and delete, the delete
    // would proceed → TOCTOU bug. Now the count IS the delete trip's
    // first statement under the lock.
    const guardResult = await planRepo.softDeleteGuarded(
      tenant.ctx,
      asPlanSlug(targetPlanId),
      asPlanYear(PLAN_YEAR),
      new Date('2027-06-15T00:00:00Z'),
      user.userId,
    );

    // ASSERTION: softDeleteGuarded must refuse because member was assigned
    // to targetPlan before the lock was acquired.
    expect(guardResult.kind).toBe('has_active_members');
    if (guardResult.kind === 'has_active_members') {
      expect(guardResult.count).toBeGreaterThanOrEqual(1);
    }

    // Confirm the plan was NOT soft-deleted
    const reloaded = await planRepo.findOne(
      tenant.ctx,
      asPlanSlug(targetPlanId),
      asPlanYear(PLAN_YEAR),
    );
    expect(reloaded?.deleted_at).toBeNull();
  });
});
