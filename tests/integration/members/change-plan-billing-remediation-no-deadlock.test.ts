/**
 * Step 2.3 (plan-change immediate re-freeze, Phase 2) — the billing-effect
 * remediation must NOT self-deadlock under change-plan's member FOR UPDATE lock.
 *
 * change-plan holds the member row FOR UPDATE inside a single `runInTenant` tx
 * and, with the flag on, calls the renewals billing remediation on THAT SAME tx
 * (open-cycle lookup, cycle advisory lock, issued-invoice probe, re-freeze,
 * audit emit — all on the caller tx). The one exception is the F2 plan-frozen-
 * fields lookup, which reads the (never-locked) `membership_plans` table on its
 * own connection; it can never block on the member-row lock, so the chain
 * completes without a cross-connection stall.
 *
 * THE REGRESSION THIS GUARDS: introducing a nested `runInTenant` that WRITES the
 * locked member row (or any row the outer tx locked) — e.g. an audit whose
 * payload re-fires `members_audit_bump_last_activity` on a second connection —
 * self-deadlocks. On the pooled dev endpoint `statement_timeout` is dropped to
 * 0, so it hangs forever. A watchdog cancels ONLY backends blocked by a lock
 * during the drive, standing in for the prod `statement_timeout`, so a
 * regression FAILS fast instead of wedging the shared DB.
 *
 * Live Neon Singapore via .env.local.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { changePlan } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makePlanChangeBillingRemediation } from '@/modules/renewals';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';

describe('change-plan billing remediation — no self-deadlock under member lock', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  async function seedMemberWithOpenCycle(): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `NoDeadlock Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        turnoverThb: 120_000_000,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-01-01T00:00:00.000Z'),
        periodTo: new Date('2027-01-01T00:00:00.000Z'),
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
    return memberId;
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    for (const [planId, fee, tier] of [
      ['regular', 5_000_000, 'regular'],
      ['premium', 9_000_000, 'premium'],
    ] as const) {
      await runInTenant(tenant.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId,
          planName: { en: planId },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
          annualFeeMinorUnits: fee,
          renewalTierBucket: tier,
        }),
      );
    }
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    for (const q of [
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
  });

  it('drives change-plan end-to-end (flag on, open cycle) to completion in a few seconds, no deadlock', async () => {
    const memberId = await seedMemberWithOpenCycle();
    const deps = {
      ...buildMembersDeps(tenant.ctx),
      applyPlanChangeToBilling: makePlanChangeBillingRemediation(tenant.ctx.slug, {
        immediateRefreezeEnabled: true,
      }),
    };

    let done = false;
    let cancelled = 0;
    const start = Date.now();
    const change = changePlan(
      memberId,
      { new_plan_id: 'premium', new_plan_year: 2026 },
      { actorUserId: admin.userId, requestId: `nd-${randomUUID().slice(0, 8)}` },
      deps,
    ).finally(() => {
      done = true;
    });

    // Watchdog stands in for the prod statement_timeout the pooled dev endpoint
    // drops to 0: if the drive stalls (a regression introduced a member-row-
    // touching nested runInTenant), cancel the backends a lock has blocked so
    // the test fails fast instead of wedging the shared DB. On correct code the
    // drive finishes in <1s and this cancels nothing.
    const deadline = Date.now() + 30_000;
    while (!done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      if (done) break;
      if (Date.now() - start < 8_000) continue;
      const blocked = (await db.execute(
        sql`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database()
              AND cardinality(pg_blocking_pids(pid)) > 0`,
      )) as unknown as Array<{ pid: number }>;
      for (const b of blocked) {
        await db.execute(sql`SELECT pg_cancel_backend(${Number(b.pid)})`);
        cancelled += 1;
      }
    }

    const result = await change;
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    expect(
      cancelled,
      'the drive must not self-deadlock (watchdog cancelled a lock-blocked backend)',
    ).toBe(0);
    expect(
      elapsed,
      `change-plan + billing remediation must complete in a few seconds (took ${elapsed}ms)`,
    ).toBeLessThan(8_000);
  }, 60_000);
});
