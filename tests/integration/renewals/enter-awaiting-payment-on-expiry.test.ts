/**
 * F8-completion slice 2 · Task 2.3 — `enterAwaitingPaymentOnExpiry`
 * integration test (live Neon).
 *
 * Verifies the T-0 expiry cron on real Postgres + RLS:
 *
 *   1. **flip** — an `upcoming` cycle past T-0 → transitions to
 *      `awaiting_payment` on disk + emits the
 *      `renewal_entered_awaiting_payment` audit (source:'cron').
 *   2. **compose** — the LAPSE cron then sees the just-flipped cycle as
 *      `awaiting_payment` and (once the grace window elapses) lapses it.
 *      The two crons compose end-to-end: enter → awaiting_payment,
 *      later lapse → lapsed.
 *   3. **cross-tenant isolation** — tenant A's cron cannot flip tenant
 *      B's eligible cycle (Constitution Principle I two-layer isolation;
 *      RLS scopes the eligibility list + the per-cycle re-read).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { tenantRenewalSettings } from '@/modules/renewals/infrastructure/schema-tenant-renewal-config';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  enterAwaitingPaymentOnExpiry,
  lapseCyclesOnGraceExpiry,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('F8 enterAwaitingPaymentOnExpiry — integration (slice 2 / T2.3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  // enter-awaiting NOW = 2026-05-30; cycle expires 2026-05-29 (past T-0).
  const NOW_ENTER = new Date('2026-05-30T08:00:00Z');
  const EXPIRES_AT = new Date('2026-05-29T00:00:00Z');
  // lapse NOW = far past grace (14d) → 2026-07-15 (> 2026-05-29 + 14d).
  const NOW_LAPSE = new Date('2026-07-15T08:00:00Z');

  // tenant A: one upcoming cycle past T-0 (flips + composes with lapse).
  const memberA = randomUUID();
  const cycleA = randomUUID();
  // tenant B: one upcoming cycle past T-0 (must NOT be flipped by A's cron).
  const memberB = randomUUID();
  const cycleB = randomUUID();

  async function seedTenant(
    tenant: TestTenant,
    memberId: string,
    cycleId: string,
  ): Promise<void> {
    const planId = `f8-enter-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Enter Awaiting Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .insert(tenantRenewalSettings)
        .values({
          tenantId: tenant.ctx.slug,
          gracePeriodDays: 14,
          autoUpgradeEnabled: true,
          minTenureDaysForAtRisk: 30,
          dispatchCronEnabled: true,
        })
        .onConflictDoNothing(),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: 1,
        companyName: `Enter Co ${memberId.slice(0, 6)}`,
        country: 'TH' as const,
        planId,
        planYear: 2026,
      }),
    );
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'upcoming',
        periodFrom: new Date('2025-05-29T00:00:00Z'),
        periodTo: EXPIRES_AT,
        expiresAt: EXPIRES_AT,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
  }

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    await seedTenant(tenantA, memberA, cycleA);
    await seedTenant(tenantB, memberB, cycleB);
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(members)
        .where(eq(members.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 60_000);

  it('flips an upcoming cycle to awaiting_payment + emits the audit, and the lapse cron then composes (enter -> awaiting -> lapsed); cross-tenant isolation holds', async () => {
    // --- 1. tenant A's enter-awaiting cron flips A's cycle ---------------
    const depsA = makeRenewalsDeps(tenantA.ctx.slug);
    const enterResult = await enterAwaitingPaymentOnExpiry(depsA, {
      tenantId: tenantA.ctx.slug,
      now: NOW_ENTER,
      correlationId: randomUUID(),
    });
    expect(enterResult.ok).toBe(true);
    if (!enterResult.ok) return;
    expect(enterResult.value.cyclesProcessed).toBe(1);
    expect(enterResult.value.flipped).toBe(1);
    expect(enterResult.value.raceSkipped).toBe(0);
    expect(enterResult.value.errors).toBe(0);

    // Cycle A is now awaiting_payment on disk.
    const aAfterEnter = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleA)),
    );
    expect(aAfterEnter[0]?.status).toBe('awaiting_payment');

    // The renewal_entered_awaiting_payment audit landed with source:'cron'.
    // (eventType is cast — the Drizzle pgEnum TS union lags the DB enum;
    // precedent: create-next-cycle-on-paid.test.ts.)
    const enterAudits = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType, payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(
              auditLog.eventType,
              'renewal_entered_awaiting_payment' as never,
            ),
          ),
        ),
    );
    expect(enterAudits.length).toBe(1);
    expect(enterAudits[0]?.payload).toMatchObject({
      cycle_id: cycleA,
      member_id: memberA,
      source: 'cron',
    });

    // --- 2. cross-tenant isolation: B's cycle is untouched --------------
    const bAfterEnter = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select({ status: renewalCycles.status })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleB)),
    );
    expect(bAfterEnter[0]?.status).toBe('upcoming'); // A's cron did NOT flip B

    // --- 3. compose: the LAPSE cron now sees A's awaiting_payment cycle --
    const lapseResult = await lapseCyclesOnGraceExpiry(depsA, {
      tenantId: tenantA.ctx.slug,
      now: NOW_LAPSE,
      correlationId: randomUUID(),
    });
    expect(lapseResult.ok).toBe(true);
    if (!lapseResult.ok) return;
    expect(lapseResult.value.cyclesProcessed).toBe(1);
    expect(lapseResult.value.graceExpired).toBe(1); // no F5 payments → grace_expired

    const aAfterLapse = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleA)),
    );
    expect(aAfterLapse[0]?.status).toBe('lapsed');
    expect(aAfterLapse[0]?.closedReason).toBe('grace_expired');
  });
});
