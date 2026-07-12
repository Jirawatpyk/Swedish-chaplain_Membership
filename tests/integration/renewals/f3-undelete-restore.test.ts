/**
 * Cluster 4 (2026-07-12) — F3 undelete → F8 renewal-cycle RESTORE
 * integration test (live Neon).
 *
 * Closes the archive/undelete asymmetry: archiving a member cancels the
 * in-flight cycle (F8 cascade), but undelete previously restored ONLY the
 * member row, so the member silently dropped out of the renewal pipeline.
 * `undelete-member` now runs a POST-COMMIT best-effort restore cascade
 * (`RenewalsCascadePort.restoreForMember` → F8 `restoreCycleForMember`) that
 * idempotently re-creates ONE active cycle anchored to the CURRENT membership
 * period.
 *
 * End-to-end lifecycle pinned here:
 *   1. Seed an ACTIVE member with one in-flight (upcoming) cycle.
 *   2. Cancel the cycle via `cancelInFlightCyclesForMember` (simulates the
 *      archive cascade) + flip the member row to `archived`.
 *   3. Run the REAL `undeleteMember` use-case (via `buildMembersDeps`, which
 *      wires the real `f8RenewalsCascadeAdapter`).
 *   4. Assert: member is `active` again; the old cycle stays `cancelled`;
 *      EXACTLY ONE non-terminal cycle now exists (the restored one); the
 *      member re-appears in the renewal pipeline (`findActiveForMember`
 *      returns it); a `renewal_cycle_created` audit row was emitted.
 *
 * Idempotency:
 *   5. Call `restoreForMember` again while an active cycle already exists →
 *      `skipped_active_exists`, still EXACTLY ONE non-terminal cycle (no
 *      duplicate).
 *
 * Cross-tenant isolation (Constitution Principle I clause 3):
 *   6. `restoreForMember` for tenant B with tenant A's member-id →
 *      `skipped_member_absent` (RLS hides the member); tenant A untouched and
 *      no cycle created in tenant B.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { undeleteMember, asMemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { f8RenewalsCascadeAdapter } from '@/modules/members/infrastructure/adapters/renewals-cascade-adapter';
import {
  cancelInFlightCyclesForMember,
  makeRenewalsDeps,
  isTerminalCycleStatus,
  type CycleStatus,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

// Registration anchor in the current (January-start) fiscal year 2026 and in
// the past relative to now, so `anchorToCurrentPeriod` lands the restored
// cycle on the current period (period_to > now) inside FY2026 — the year the
// seeded plan is priced for (no fiscal-year-boundary flake).
const REGISTRATION_DATE = '2026-02-01';
const SEED_PERIOD_FROM = new Date('2026-02-01T00:00:00.000Z');
const SEED_EXPIRES_AT = new Date('2027-02-01T00:00:00.000Z');

async function countNonTerminalCycles(
  tenantSlug: string,
  memberId: string,
): Promise<number> {
  const rows = await db
    .select({ status: renewalCycles.status })
    .from(renewalCycles)
    .where(
      and(
        eq(renewalCycles.tenantId, tenantSlug),
        eq(renewalCycles.memberId, memberId),
      ),
    );
  return rows.filter((r) => !isTerminalCycleStatus(r.status as CycleStatus))
    .length;
}

describe('F3 undelete → F8 cycle restore — Cluster 4', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let memberId: string;
  let seedCycleId: string;
  let planId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);

    memberId = randomUUID();
    seedCycleId = randomUUID();
    planId = `f8-restore-${randomUUID().slice(0, 8)}`;

    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Restore Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Restore Test Co',
        country: 'TH',
        planId,
        planYear: 2026,
        registrationDate: REGISTRATION_DATE,
        status: 'active',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: seedCycleId,
        memberId,
        status: 'upcoming',
        periodFrom: SEED_PERIOD_FROM,
        periodTo: SEED_EXPIRES_AT,
        expiresAt: SEED_EXPIRES_AT,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('undelete re-creates exactly one active cycle; member re-appears in the renewal pipeline', async () => {
    // 1. Simulate the archive cascade: cancel the in-flight cycle.
    const cancelDeps = makeRenewalsDeps(tenant.ctx.slug);
    const cancel = await cancelInFlightCyclesForMember(cancelDeps, {
      tenant: tenant.ctx,
      memberId: memberId as never,
      cascadeReason: 'originator_member_archived',
      initiatedByUserId: admin.userId,
      requestId: null,
      correlationId: randomUUID(),
    });
    expect(cancel.ok).toBe(true);
    if (!cancel.ok) return;
    expect(cancel.value.outcome).toBe('ok');
    // The seeded cycle is now cancelled → the member has NO active cycle (the
    // exact bug: they have dropped out of the pipeline).
    expect(await countNonTerminalCycles(tenant.ctx.slug, memberId)).toBe(0);

    // 2. Flip the member row to archived (mirrors archive-member's mutation).
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(members)
        .set({ status: 'archived', archivedAt: new Date() })
        .where(
          and(
            eq(members.tenantId, tenant.ctx.slug),
            eq(members.memberId, memberId),
          ),
        ),
    );

    // 3. Run the REAL undelete use-case (wires the real restore adapter).
    const deps = buildMembersDeps(tenant.ctx);
    const result = await undeleteMember(
      asMemberId(memberId),
      { actorUserId: admin.userId, requestId: randomUUID() },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');

    // 4a. Exactly ONE non-terminal cycle exists (the restored one).
    expect(await countNonTerminalCycles(tenant.ctx.slug, memberId)).toBe(1);

    // 4b. The old seeded cycle is still cancelled (append-only forensic trail —
    // restore re-creates fresh, it does not un-cancel).
    const oldCycle = await db
      .select({ status: renewalCycles.status })
      .from(renewalCycles)
      .where(
        and(
          eq(renewalCycles.tenantId, tenant.ctx.slug),
          eq(renewalCycles.cycleId, seedCycleId),
        ),
      );
    expect(oldCycle[0]!.status).toBe('cancelled');

    // 4c. The member re-appears in the renewal pipeline (findActiveForMember
    // returns the restored, non-terminal cycle with correct current-period
    // dates — not the stale/expired seeded window).
    const restored = await cancelDeps.cyclesRepo.findActiveForMember(
      tenant.ctx.slug,
      memberId,
    );
    expect(restored).not.toBeNull();
    expect(restored!.cycleId).not.toBe(seedCycleId);
    expect(isTerminalCycleStatus(restored!.status)).toBe(false);
    // Anchored to the current period → not yet expired (periodTo is ISO 8601).
    expect(Date.parse(restored!.periodTo)).toBeGreaterThan(Date.now());

    // 4d. A renewal_cycle_created audit was emitted for the restore.
    const auditRows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'renewal_cycle_created' as never),
        ),
      );
    const restoreAudit = auditRows.filter(
      (r) => (r.payload as { member_id?: string }).member_id === memberId,
    );
    expect(restoreAudit).toHaveLength(1);
  });

  it('idempotent — restoring again when an active cycle exists creates NO duplicate', async () => {
    const before = await countNonTerminalCycles(tenant.ctx.slug, memberId);
    expect(before).toBe(1);

    const outcome = await f8RenewalsCascadeAdapter.restoreForMember(
      tenant.ctx,
      asMemberId(memberId),
      { initiatedByUserId: admin.userId, requestId: null },
    );
    expect(outcome.outcome).toBe('skipped_active_exists');

    // Still exactly one — no second active cycle.
    expect(await countNonTerminalCycles(tenant.ctx.slug, memberId)).toBe(1);
  });

  it('cross-tenant isolation — restore for tenant B with tenant A member-id is a no-op (Principle I clause 3)', async () => {
    const tenantB = await createTestTenant('test-chamber');
    try {
      const outcome = await f8RenewalsCascadeAdapter.restoreForMember(
        tenantB.ctx,
        asMemberId(memberId), // tenant A's member id — RLS hides it in B
        { initiatedByUserId: admin.userId, requestId: null },
      );
      // The member is unreadable in tenant B → skip (no cycle created).
      expect(outcome.outcome).toBe('skipped_member_absent');

      const tenantBCycles = await db
        .select({ cycleId: renewalCycles.cycleId })
        .from(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenantB.ctx.slug));
      expect(tenantBCycles).toHaveLength(0);

      // Tenant A still has exactly one active cycle — untouched.
      expect(await countNonTerminalCycles(tenant.ctx.slug, memberId)).toBe(1);
    } finally {
      await tenantB.cleanup().catch(() => {});
    }
  });
});
