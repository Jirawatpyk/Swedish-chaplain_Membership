/**
 * F8 Phase 5 Wave D · T146 — lapsed-portal-scope integration test
 * (live Neon).
 *
 * 059-membership-suspension Task 3: repointed onto `checkPortalAccess`,
 * the two-policy resolver built on `deriveMembershipAccess` +
 * `findLatestCycleForMember`. UNLIKE the old `findActiveForMember`-backed
 * helper (whose repo predicate excludes `status='lapsed'`, making the
 * lapsed-blocking branch untestable on live Neon — see git history),
 * `findLatestCycleForMember` returns a cycle regardless of status, so
 * this suite now exercises the terminated-block branch for real.
 *
 * Verifies `checkPortalAccess` against real cycles in Postgres:
 *
 *   1. Member without any cycle → allowed (`full`)
 *   2. Cycle in `awaiting_payment` → allowed (`suspended_route_allowed`;
 *      `awaiting_payment` derives to `suspended`, not `full`)
 *   3. Cycle `lapsed` + expired (terminated) + non-whitelisted route →
 *      blocked
 *   4. Cycle `lapsed` + expired (terminated) + whitelisted route →
 *      allowed (`route_whitelisted`)
 *   5. Block emits `lapsed_member_action_blocked` audit row
 *   6. Cross-tenant isolation: tenant B has no view of tenant A's
 *      members (RLS) → `full`
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps } from '@/modules/renewals';
import { checkPortalAccess } from '@/lib/lapsed-portal-scope';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

/**
 * 059-membership-suspension task-19b (final gate sweep) — poll/retry for
 * the ONE assertion in this file that races a fire-and-forget audit write.
 *
 * `checkPortalAccess`'s fail-open branch calls `emitFailOpen()`
 * (`src/lib/lapsed-portal-scope.ts:389-422`) WITHOUT awaiting it — by
 * design (a logging/audit hiccup must never delay or block the
 * already-decided fail-open response). Every OTHER audit emit in this
 * suite (`emitTerminatedBlockedAudit`, `emitSuspendedBlockedAudit`) IS
 * awaited by `checkPortalAccess` before it returns, so their audit-row
 * assertions are safe to query immediately. Only the fail-open assertion
 * needs to tolerate the row not being visible yet — this polls up to
 * ~2s (bounded) rather than adding an `await` to production code.
 */
async function pollAuditRowsByRequestId(
  requestId: string,
  { timeoutMs = 2000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Array<typeof auditLog.$inferSelect>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('F8 lapsed-portal-scope — integration (T146)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  let lapsedMemberId: string;
  let lapsedCycleId: string;
  let activeMemberId: string;
  let activeCycleId: string;
  let memberWithoutCycle: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    const planId = `f8-lapsed-${randomUUID().slice(0, 8)}`;
    lapsedMemberId = randomUUID();
    lapsedCycleId = randomUUID();
    activeMemberId = randomUUID();
    activeCycleId = randomUUID();
    memberWithoutCycle = randomUUID();

    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Lapsed Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    // Member with lapsed active cycle.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values([
        {
          tenantId: tenantA.ctx.slug,
          memberId: lapsedMemberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Lapsed Co',
          country: 'TH',
          planId,
          planYear: 2026,
        },
        {
          tenantId: tenantA.ctx.slug,
          memberId: activeMemberId,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'Active Co',
          country: 'TH',
          planId,
          planYear: 2026,
        },
        {
          tenantId: tenantA.ctx.slug,
          memberId: memberWithoutCycle,
          memberNumber: nextSeedMemberNumber(),
          companyName: 'No-Cycle Co',
          country: 'TH',
          planId,
          planYear: 2026,
        },
      ]),
    );

    // Active (non-terminal) cycle in `awaiting_payment` — derives to
    // `suspended` per `deriveMembershipAccess` (unpaid, not yet expired-
    // terminal). Used to exercise the suspended-allow branch below.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values([
        {
          tenantId: tenantA.ctx.slug,
          cycleId: activeCycleId,
          memberId: activeMemberId,
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
        },
      ]),
    );

    // Terminated cycle: `lapsed` status + `expiresAt` in the past. Per the
    // DB CHECK `renewal_cycles_closed_at_iff_terminal_check`, a terminal
    // status (`lapsed`/`cancelled`/`completed`) REQUIRES `closed_at` set.
    // `findLatestCycleForMember` (Task 2) — UNLIKE `findActiveForMember` —
    // returns this row, so `deriveMembershipAccess` can classify it
    // `terminated` (grace-expired). This is the row the old helper could
    // never see; it makes the terminated-block branch testable on live
    // Neon for the first time.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values([
        {
          tenantId: tenantA.ctx.slug,
          cycleId: lapsedCycleId,
          memberId: lapsedMemberId,
          status: 'lapsed',
          periodFrom: new Date('2019-01-01T00:00:00Z'),
          periodTo: new Date('2020-01-01T00:00:00Z'),
          expiresAt: new Date('2020-01-01T00:00:00Z'),
          closedAt: new Date('2020-02-01T00:00:00Z'),
          closedReason: 'lapsed',
          cycleLengthMonths: 12,
          tierAtCycleStart: 'regular',
          planIdAtCycleStart: randomUUID(),
          frozenPlanPriceThb: '50000.00',
          frozenPlanTermMonths: 12,
          frozenPlanCurrency: 'THB',
        },
      ]),
    );
    void tenantB; // imported for parity with tenantA cleanup
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, t.ctx.slug))
        .catch(() => {});
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('terminated member + whitelisted /portal/renewal/* → allowed', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await checkPortalAccess(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: lapsedMemberId,
      pathname: '/portal/renewal/abc',
      actorUserId: user.userId,
      correlationId: randomUUID(),
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('route_whitelisted');
  });

  it('terminated member + whitelisted /portal/preferences/renewals → allowed', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await checkPortalAccess(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: lapsedMemberId,
      pathname: '/portal/preferences/renewals',
      actorUserId: user.userId,
      correlationId: randomUUID(),
    });
    expect(r.allowed).toBe(true);
  });

  it('terminated member + non-whitelisted route → blocked + emits audit', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const correlationId = randomUUID();
    const r = await checkPortalAccess(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: lapsedMemberId,
      pathname: '/portal/dashboard',
      actorUserId: user.userId,
      correlationId,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe('terminated_route_blocked');
      expect(r.cycleId).toBe(lapsedCycleId);
    }

    // `ctx.requestId` was not passed, so the adapter falls back to storing
    // `correlationId` in the `request_id` column (see
    // `buildInsertValues` — `requestId: ctx.requestId ?? ctx.correlationId`).
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, correlationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('lapsed_member_action_blocked');
  });

  it('no cycle at all → allowed (full)', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await checkPortalAccess(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: memberWithoutCycle,
      pathname: '/portal/dashboard',
      actorUserId: user.userId,
      correlationId: randomUUID(),
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('full');
  });

  it('cycle in awaiting_payment (suspended) + non-denylisted route → allowed', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const r = await checkPortalAccess(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: activeMemberId,
      pathname: '/portal/billing',
      actorUserId: user.userId,
      correlationId: randomUUID(),
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('suspended_route_allowed');
  });

  // 059-membership-suspension Task 8 — proves the `membership_suspended_
  // action_blocked` enum value exists live (migration 0245) AND that it is
  // discriminated from `lapsed_member_action_blocked` (which the earlier
  // "terminated member" test above still exercises).
  it('cycle in awaiting_payment (suspended) + denylisted /portal/broadcasts/new → blocked + emits membership_suspended_action_blocked (Task 8)', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const correlationId = randomUUID();
    const r = await checkPortalAccess(deps, {
      tenantId: tenantA.ctx.slug,
      memberId: activeMemberId,
      pathname: '/portal/broadcasts/new',
      actorUserId: user.userId,
      correlationId,
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe('suspended_route_blocked');
      expect(r.cycleId).toBe(activeCycleId);
    }

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, correlationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('membership_suspended_action_blocked');
    expect(rows[0]?.payload).toMatchObject({
      cycle_id: activeCycleId,
      member_id: activeMemberId,
      blocked_route: '/portal/broadcasts/new',
      access_state: 'suspended',
    });
  });

  // 059-membership-suspension Task 8 — proves the `membership_access_
  // fail_open` enum value exists live (migration 0245). Forces the
  // cyclesRepo read to throw while keeping every OTHER dep (crucially
  // `auditEmitter`) real, so the emit round-trips through the actual
  // Drizzle F8 audit adapter into Postgres.
  it('cyclesRepo read failure → fail-open + emits membership_access_fail_open (Task 8, real audit adapter)', async () => {
    const realDeps = makeRenewalsDeps(tenantA.ctx.slug);
    const correlationId = randomUUID();
    const throwingDeps = {
      ...realDeps,
      cyclesRepo: {
        ...realDeps.cyclesRepo,
        findLatestCycleForMember: async () => {
          throw new Error('simulated connection reset (Task 8 fail-open proof)');
        },
      },
    };
    const r = await checkPortalAccess(throwingDeps, {
      tenantId: tenantA.ctx.slug,
      memberId: activeMemberId,
      pathname: '/portal/dashboard',
      actorUserId: user.userId,
      correlationId,
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('fail_open');

    // Fire-and-forget emit (see helper docstring above) — poll instead of
    // a single immediate read to avoid a test-race in a concurrent batch.
    const rows = await pollAuditRowsByRequestId(correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('membership_access_fail_open');
    expect(rows[0]?.payload).toMatchObject({
      member_id: activeMemberId,
      blocked_route: '/portal/dashboard',
      error: 'simulated connection reset (Task 8 fail-open proof)',
    });
  });

  it('cross-tenant: tenant B has no view of tenant A members → full', async () => {
    // tenant B context — none of A's members exist in B's RLS scope,
    // so findLatestCycleForMember returns null → full access.
    const depsB = makeRenewalsDeps(tenantB.ctx.slug);
    const r = await checkPortalAccess(depsB, {
      tenantId: tenantB.ctx.slug,
      memberId: activeMemberId, // belongs to tenant A
      pathname: '/portal/dashboard',
      actorUserId: user.userId,
      correlationId: randomUUID(),
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) expect(r.reason).toBe('full');
  });
});
