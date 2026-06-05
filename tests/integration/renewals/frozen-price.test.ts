/**
 * F8 Phase 5 Wave D · T149 — frozen-price invariant integration test.
 *
 * Verifies FR-021a + FR-021b on live Neon:
 *
 *   1. **F2 plan price changes mid-cycle do NOT shift the cycle's
 *      frozen price.** The cycle row's `frozen_plan_price_thb` is set
 *      at cycle creation and is the single source of truth thereafter.
 *      A subsequent UPDATE on `membership_plans.annual_fee_minor_units`
 *      leaves the cycle's frozen value untouched.
 *
 *   2. **Plan-change during confirm atomically updates frozen fields
 *      (FR-021b).** When a member picks a different plan during the
 *      confirm flow, `cyclesRepo.updateFrozenPlan` UPDATEs all four
 *      frozen columns + tier in a single statement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import { makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F8 frozen-price invariant — integration (T149)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberIdA: string;
  let cycleIdA: string;
  let originalPlanId: string;
  let upgradePlanId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();

    originalPlanId = `f8-frozen-orig-${randomUUID().slice(0, 8)}`;
    upgradePlanId = `f8-frozen-up-${randomUUID().slice(0, 8)}`;
    memberIdA = randomUUID();
    cycleIdA = randomUUID();

    // Seed two plans: the cycle's original (regular @ 50,000 THB) and
    // a premium upgrade target (@ 180,000 THB).
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: originalPlanId,
        planName: { en: 'Frozen Original' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId: upgradePlanId,
        planName: { en: 'Frozen Upgrade' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    // Set the upgrade plan to a higher fee + premium tier so the
    // plan-change branch has visible delta to assert against.
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({
          annualFeeMinorUnits: 18_000_000, // 180,000.00 THB
          renewalTierBucket: 'premium',
        })
        .where(eq(membershipPlans.planId, upgradePlanId)),
    );

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId: memberIdA,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Frozen Co',
        country: 'TH',
        planId: originalPlanId,
        planYear: 2026,
      }),
    );
    // Cycle created with frozen price 50,000.00 THB on the original plan.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: cycleIdA,
        memberId: memberIdA,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('FR-021a: F2 plan price change does NOT shift the cycle frozen price', async () => {
    const cycleId = asCycleId(cycleIdA);
    // Read original frozen price from the cycle.
    const before = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ frozen: renewalCycles.frozenPlanPriceThb })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(before[0]?.frozen).toBe('50000.00');

    // Mid-cycle, the F2 plan price gets bumped (e.g. annual catalogue
    // adjustment). This is exactly the scenario FR-021a guards.
    await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({ annualFeeMinorUnits: 8_500_000 }) // 85,000.00 THB
        .where(eq(membershipPlans.planId, originalPlanId)),
    );

    // Re-read the cycle: frozen price MUST still be 50,000 — the
    // de-normalised cycle row never reads from F2 again after creation.
    const after = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ frozen: renewalCycles.frozenPlanPriceThb })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(after[0]?.frozen).toBe('50000.00');
  });

  it('FR-021b: updateFrozenPlan atomically updates all four frozen columns', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const cycleId = asCycleId(cycleIdA);
    // T149 follow-up RESOLVED via migration 0113:
    // `renewal_cycles.plan_id_at_cycle_start` is now TEXT and matches
    // `membership_plans.plan_id`. This test still uses a randomUUID()
    // because it only exercises the column round-trip — it does not
    // resolve the value against F2. Other tests that DO need an F2
    // lookup (e.g. cycle-detail page) pass a real plan slug.
    const newPlanUuid = randomUUID();

    await runInTenant(tenantA.ctx, async (tx) => {
      const updated = await deps.cyclesRepo.updateFrozenPlan(
        tx,
        tenantA.ctx.slug,
        cycleId,
        {
          planIdAtCycleStart: newPlanUuid,
          tierAtCycleStart: 'premium',
          frozenPlanPriceThb: '180000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        },
      );
      expect(updated.frozenPlanPriceThb).toBe('180000.00');
      expect(updated.tierAtCycleStart).toBe('premium');
      expect(updated.planIdAtCycleStart).toBe(newPlanUuid);
    });

    // Verify the row now reflects the new frozen state.
    const row = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          price: renewalCycles.frozenPlanPriceThb,
          tier: renewalCycles.tierAtCycleStart,
          planId: renewalCycles.planIdAtCycleStart,
          term: renewalCycles.frozenPlanTermMonths,
          currency: renewalCycles.frozenPlanCurrency,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleId))
        .limit(1),
    );
    expect(row[0]).toEqual({
      price: '180000.00',
      tier: 'premium',
      planId: newPlanUuid,
      term: 12,
      currency: 'THB',
    });
  });
});
