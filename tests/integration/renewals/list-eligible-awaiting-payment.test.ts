/**
 * F8-completion slice 2 · Task 2.2 — `listCyclesEligibleForAwaitingPayment`
 * repo-method integration test (live Neon).
 *
 * The T-0 expiry cron flips cycles `upcoming|reminded` → `awaiting_payment`
 * once `expires_at <= now`. This eligibility cursor is the cron's first
 * read. Verifies on real Postgres + RLS:
 *
 *   1. an `upcoming` cycle with `expires_at <= now` → RETURNED
 *   2. an `upcoming` cycle with `expires_at > now` (not yet at T-0) → NOT returned
 *   3. a `reminded` cycle with `expires_at <= now` → RETURNED
 *   4. a cycle in a NON-eligible status (awaiting_payment) past T-0 →
 *      NOT returned (the cron must not re-flip an already-payable cycle)
 *   5. ordering — `expires_at ASC` (oldest first; smallest blast radius
 *      if the cron is partially executed)
 *
 * The `<= now` boundary (vs the lapse cron's `< now - grace`) is the
 * load-bearing contract: a cycle is never simultaneously eligible for
 * both the enter-awaiting flip and the lapse transition in one cron pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('F8 listCyclesEligibleForAwaitingPayment — integration (slice 2 / T2.2)', () => {
  let tenantA: TestTenant;
  let user: TestUser;

  // NOW = 2026-05-30. Eligible cycles have expires_at <= NOW.
  const NOW_ISO = new Date('2026-05-30T08:00:00Z').toISOString();

  // Eligible (returned): upcoming past T-0, reminded past T-0, upcoming AT T-0.
  const cycleUpcomingPastT0 = randomUUID(); // expires 2026-05-01 (oldest)
  const cycleRemindedPastT0 = randomUUID(); // expires 2026-05-15
  const cycleUpcomingAtT0 = randomUUID(); // expires === NOW (boundary, <=)

  // Not eligible.
  const cycleUpcomingFutureT0 = randomUUID(); // expires 2026-06-30 (> now)
  const cycleAlreadyAwaiting = randomUUID(); // status awaiting_payment (not upcoming|reminded)

  const expectedOrderedEligible = [
    cycleUpcomingPastT0, // 2026-05-01
    cycleRemindedPastT0, // 2026-05-15
    cycleUpcomingAtT0, // 2026-05-30 (=== now)
  ];

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();
    const planId = `f8-eligawait-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Eligible Awaiting Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    // One member per cycle to satisfy the active-member uniqueness on
    // renewal_cycles (one active cycle per member). member_number is
    // NOT NULL + per-tenant UNIQUE.
    const memberIds = [
      cycleUpcomingPastT0,
      cycleRemindedPastT0,
      cycleUpcomingAtT0,
      cycleUpcomingFutureT0,
      cycleAlreadyAwaiting,
    ].map((c) => ({ cycleId: c, memberId: randomUUID() }));

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values(
        memberIds.map((m, i) => ({
          tenantId: tenantA.ctx.slug,
          memberId: m.memberId,
          memberNumber: i + 1,
          companyName: `Awaiting Co ${m.memberId.slice(0, 6)}`,
          country: 'TH' as const,
          planId,
          planYear: 2026,
        })),
      ),
    );

    const seedCycle = (
      cycleId: string,
      memberId: string,
      status: 'upcoming' | 'reminded' | 'awaiting_payment',
      expiresAtIso: string,
    ) =>
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(renewalCycles).values({
          tenantId: tenantA.ctx.slug,
          cycleId,
          memberId,
          status,
          periodFrom: new Date('2025-05-01T00:00:00Z'),
          periodTo: new Date(expiresAtIso),
          expiresAt: new Date(expiresAtIso),
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: 'regular',
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        }),
      );

    const byCycle = new Map(memberIds.map((m) => [m.cycleId, m.memberId]));
    await seedCycle(cycleUpcomingPastT0, byCycle.get(cycleUpcomingPastT0)!, 'upcoming', '2026-05-01T00:00:00Z');
    await seedCycle(cycleRemindedPastT0, byCycle.get(cycleRemindedPastT0)!, 'reminded', '2026-05-15T00:00:00Z');
    await seedCycle(cycleUpcomingAtT0, byCycle.get(cycleUpcomingAtT0)!, 'upcoming', NOW_ISO);
    await seedCycle(cycleUpcomingFutureT0, byCycle.get(cycleUpcomingFutureT0)!, 'upcoming', '2026-06-30T00:00:00Z');
    await seedCycle(cycleAlreadyAwaiting, byCycle.get(cycleAlreadyAwaiting)!, 'awaiting_payment', '2026-05-01T00:00:00Z');
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 60_000);

  it('returns only upcoming|reminded cycles with expires_at <= now, ordered expires_at ASC', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const page = await deps.cyclesRepo.listCyclesEligibleForAwaitingPayment(
      tenantA.ctx.slug,
      { nowIso: NOW_ISO, pageSize: 100 },
    );

    const returnedIds = page.items.map((c) => c.cycleId);

    // Boundary + status filter: the 3 eligible cycles present, the 3
    // ineligible ones absent.
    expect(returnedIds).toEqual(expectedOrderedEligible);
    expect(returnedIds).not.toContain(cycleUpcomingFutureT0); // expires_at > now
    expect(returnedIds).not.toContain(cycleAlreadyAwaiting); // not upcoming|reminded

    // Every returned cycle is in an eligible status with expires_at <= now.
    for (const c of page.items) {
      expect(['upcoming', 'reminded']).toContain(c.status);
      expect(new Date(c.expiresAt).getTime()).toBeLessThanOrEqual(
        new Date(NOW_ISO).getTime(),
      );
    }
    expect(page.nextCursor).toBeNull();
  });
});
