/**
 * F8 Phase 5 Wave D · T148 — pending-reactivation timeout cron test
 * (live Neon).
 *
 * Verifies T138 reconcilePendingReactivations on real Postgres in the
 * **catch-up cron-skip-recovery scenario** (no prior audit rows seeded
 * — i.e. the cron has missed every previous day):
 *
 *   1. **Reminder ladder** with no prior audits — every CROSSED rung
 *      fires per `decideRemindersToFire` semantics (T138 review-fix):
 *      - Day 23 cycle → emits T-7 only
 *      - Day 27 cycle → emits T-7 + T-3
 *      - Day 29 cycle → emits T-7 + T-3 + T-1
 *      Aggregate counts in this run: remindersT7=3, remindersT3=2,
 *      remindersT1=1. Reminder cycles stay in pending_admin_reactivation
 *      (no transition).
 *   2. **Auto-timeout at day 30+** → I2 review-fix: cycle pending →
 *      `lapsed` with `closedReason='pending_reactivation_timed_out'`
 *      (distinguishes a system timeout from an explicit admin reject in
 *      the lapsed-tab badge without joining audit_log). Emits
 *      `lapsed_member_admin_reactivation_timed_out` audit (actor=cron,
 *      null userId).
 *
 * Skipped on live: refund cascade (Stripe live). Cycles without a
 * `linked_invoice_id` go through the bridge's `no_payment_found` path
 * — no Stripe API call. Refund-failure recovery (`timeoutRefundFailures`)
 * counter is covered by unit tests.
 *
 * Steady-state daily cron (one rung emitted per day per cycle, prior-
 * day audit rows present) is exercised by the unit-test suite at
 * `tests/unit/.../reconcile-pending-reactivations.test.ts` — this
 * integration file purposefully does NOT seed prior audits so the
 * catch-up SQL path is exercised against live Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import {
  reconcilePendingReactivations,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { f5RefundBridge } from '@/modules/renewals/infrastructure/ports-adapters/f5-refund-bridge-drizzle';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('F8 reconcilePendingReactivations — integration (T148)', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  const memberA = randomUUID();
  const memberB = randomUUID();
  const memberC = randomUUID();
  const memberD = randomUUID();
  const cycleT7 = randomUUID();
  const cycleT3 = randomUUID();
  const cycleT1 = randomUUID();
  const cycleTimeout = randomUUID();
  const NOW = new Date('2026-05-15T07:00:00Z');

  // Helper: produce ISO string for cycle entered_pending_at value
  // such that (NOW - enteredAt) === days * 1 day.
  const enteredAtForDays = (days: number) =>
    new Date(NOW.getTime() - days * 86_400_000).toISOString();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    const planId = `f8-timeout-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Timeout Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    // Seed 4 distinct members each with a pending cycle at the
    // ladder boundary days. Distinct memberIds are required by the
    // unique-active-cycle invariant.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values(
        [memberA, memberB, memberC, memberD].map((mid, i) => ({
          tenantId: tenantA.ctx.slug,
          memberId: mid,
          // 055-member-number — NOT NULL + per-tenant UNIQUE; map index → 1..N.
          memberNumber: i + 1,
          companyName: `Timeout Co ${mid.slice(0, 6)}`,
          country: 'TH' as const,
          planId,
          planYear: 2026,
        })),
      ),
    );

    const seedCycle = (
      cycleId: string,
      memberId: string,
      daysPending: number,
    ) =>
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(renewalCycles).values({
          tenantId: tenantA.ctx.slug,
          cycleId,
          memberId,
          status: 'pending_admin_reactivation',
          periodFrom: new Date('2026-01-01T00:00:00Z'),
          periodTo: new Date('2027-01-01T00:00:00Z'),
          expiresAt: new Date('2027-01-01T00:00:00Z'),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: randomUUID(),
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
          enteredPendingAt: new Date(enteredAtForDays(daysPending)),
        }),
      );
    await seedCycle(cycleT7, memberA, 23); // T-7 reminder boundary
    await seedCycle(cycleT3, memberB, 27); // T-3
    await seedCycle(cycleT1, memberC, 29); // T-1
    await seedCycle(cycleTimeout, memberD, 31); // past timeout
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

  it('reminder ladder + auto-timeout: emits audits + cancels timed-out cycle', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await reconcilePendingReactivations(
      { ...deps, f5RefundBridge },
      {
        tenantId: tenantA.ctx.slug,
        now: NOW,
        correlationId: randomUUID(),
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(4);
      // T138 catch-up review-fix: with no prior audit rows seeded for
      // these cycles, the catch-up logic fires every CROSSED ladder
      // rung — not just the day-equality match. So:
      //   - Day 23 cycle: T-7 only (T-3/T-1 thresholds not yet crossed)
      //   - Day 27 cycle: T-7 + T-3 (both crossed, neither emitted yet)
      //   - Day 29 cycle: T-7 + T-3 + T-1 (all three crossed)
      //   - Day 31 cycle: timeout (refund + lapse)
      // → remindersT7=3, remindersT3=2, remindersT1=1, timedOut=1.
      // This is the desired self-healing semantics: the daily steady-
      // state cron emits one rung per day per cycle (because each day
      // finds yesterday's audit row); a cron-skip recovers all missed
      // rungs in a single subsequent run.
      expect(r.value.remindersT7).toBe(3);
      expect(r.value.remindersT3).toBe(2);
      expect(r.value.remindersT1).toBe(1);
      expect(r.value.timedOut).toBe(1);
      expect(r.value.timeoutRefundFailures).toBe(0);
    }

    // Verify the timed-out cycle moved to cancelled (no_payment_found
    // path means no actual Stripe refund issued).
    const timedOut = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          status: renewalCycles.status,
          closedReason: renewalCycles.closedReason,
        })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, cycleTimeout))
        .limit(1),
    );
    // I2 review-fix: cron-driven auto-timeout writes
    // `status='lapsed' + closedReason='pending_reactivation_timed_out'`
    // (not `cancelled` + `admin_rejected_with_refund`). This
    // distinguishes a system timeout from an explicit admin reject in
    // the lapsed-tab badge without joining audit_log.
    expect(timedOut[0]?.status).toBe('lapsed');
    expect(timedOut[0]?.closedReason).toBe('pending_reactivation_timed_out');

    // Reminder cycles stay in pending_admin_reactivation (no transition).
    const reminderRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({
          cycleId: renewalCycles.cycleId,
          status: renewalCycles.status,
        })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenantA.ctx.slug),
            eq(renewalCycles.status, 'pending_admin_reactivation'),
          ),
        ),
    );
    expect(reminderRows.map((r) => r.cycleId).sort()).toEqual(
      [cycleT7, cycleT3, cycleT1].sort(),
    );

    // Round 3 review-fix (R3-S1) / Round 4 review-fix (R4-S2):
    // Verify all 4 distinct audit event TYPES appear. The catch-up
    // breakdown is documented at the test setup above (lines ~158-162):
    // day-23 cycle fires T-7 only (1 row), day-27 fires T-7 + T-3
    // (2 rows), day-29 fires T-7 + T-3 + T-1 (3 rows) → 1 + 2 + 3
    // = 6 reminder rows; the day-30 cycle fires the timeout audit
    // (1 row) → 7 total rows. We only assert TYPE coverage here,
    // not row count.
    const auditCounts = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select({ eventType: auditLog.eventType })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantA.ctx.slug)),
    );
    const types = auditCounts.map((r) => r.eventType);
    expect(types).toContain('lapsed_member_admin_reactivation_reminder_t-7');
    expect(types).toContain('lapsed_member_admin_reactivation_reminder_t-3');
    expect(types).toContain('lapsed_member_admin_reactivation_reminder_t-1');
    expect(types).toContain('lapsed_member_admin_reactivation_timed_out');
  });
});
