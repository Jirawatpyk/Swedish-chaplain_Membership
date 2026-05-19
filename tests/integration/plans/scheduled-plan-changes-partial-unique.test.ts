/**
 * D1 (F8 Phase 2 Wave B verify-run remediation; promoted to live test
 * at /speckit.implement Wave C T017) — `scheduled_plan_changes` partial-
 * unique invariant + RLS+FORCE coverage.
 *
 * Live-DB counterpart of the unit-mocked contract test at
 * `tests/contract/f2-scheduled-plan-change.contract.test.ts`. Asserts
 * three things only the real Postgres adapter can prove:
 *
 *   1. The partial unique
 *      `(tenant_id, member_id, effective_at_cycle_id) WHERE status='pending'`
 *      enforces "at most one pending row per (tenant, member, cycle)" at
 *      the DB layer. Without it, a Drizzle-adapter bug that forgets the
 *      supersede step would silently leave duplicate pending rows.
 *
 *   2. The supersede + insert pair is atomic — either both writes commit
 *      or neither does (Constitution Principle VIII Reliability + Wave B
 *      verify-run F1 remediation).
 *
 *   3. RLS+FORCE blocks tenantB from observing tenantA's pending rows
 *      when running inside `runInTenant(tenantB.ctx, ...)` (Constitution
 *      Principle I clause 2 — DB-layer tenant isolation).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { runInTenant } from '@/lib/db';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';
import { createTwoTestTenants } from '../helpers/test-tenant';
// R2 Batch 3b-bis — migration 0125 added FK chain
// scheduled_plan_changes → renewal_cycles → members. This helper
// seeds the prerequisite (member, cycle) pair before the test inserts
// scheduled_plan_changes rows.
import { seedMemberAndRenewalCycle } from '../helpers/seed-renewal-cycle';

describe('Integration — scheduled_plan_changes partial-unique invariant', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  it('atomic supersede+insert: re-scheduling the same (member, cycle) flips prior pending → superseded + inserts new pending in one tx', async () => {
    const pair = await createTwoTestTenants();
    cleanups.push(pair.a.cleanup, pair.b.cleanup);
    const tenant = pair.a;

    // R2 Batch 3b-bis — seed member + renewal_cycle BEFORE inserting
    // scheduled_plan_changes (migration 0125 FK chain).
    const { memberId, cycleId, ownerCleanup } = await seedMemberAndRenewalCycle({
      tenant: tenant.ctx,
    });
    cleanups.push(ownerCleanup);
    const adminId = randomUUID();

    // First schedule — superseded should be null.
    const r1 = await drizzleScheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
      tenant.ctx,
      {
        memberId,
        effectiveAtCycleId: cycleId,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-premier',
        scheduledByUserId: adminId,
        reason: 'tier upgrade accepted',
      },
    );
    expect(r1.superseded).toBeNull();
    expect(r1.inserted.status).toBe('pending');
    expect(r1.inserted.toPlanId).toBe('corporate-premier');

    // Re-schedule — prior pending must flip to superseded; new pending inserted.
    const r2 = await drizzleScheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
      tenant.ctx,
      {
        memberId,
        effectiveAtCycleId: cycleId,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-elite',
        scheduledByUserId: adminId,
      },
    );
    expect(r2.superseded).not.toBeNull();
    expect(r2.superseded?.status).toBe('superseded');
    expect(r2.superseded?.toPlanId).toBe('corporate-premier');
    expect(r2.inserted.status).toBe('pending');
    expect(r2.inserted.toPlanId).toBe('corporate-elite');

    // Both rows persisted in DB; partial unique held (only ONE pending).
    const rowsAfter = await drizzleScheduledPlanChangeRepo.listForMember(
      tenant.ctx,
      memberId,
    );
    expect(rowsAfter.length).toBe(2);
    const pendingCount = rowsAfter.filter((r) => r.status === 'pending').length;
    expect(pendingCount).toBe(1);
  }, 30_000);

  it('partial unique rejects a second concurrent pending insert if supersede is skipped', async () => {
    const pair = await createTwoTestTenants();
    cleanups.push(pair.a.cleanup, pair.b.cleanup);
    const tenant = pair.a;

    // R2 Batch 3b-bis — seed member + renewal_cycle (migration 0125 FK).
    const { memberId, cycleId, ownerCleanup } = await seedMemberAndRenewalCycle({
      tenant: tenant.ctx,
    });
    cleanups.push(ownerCleanup);
    const adminId = randomUUID();

    // Insert one pending row directly — bypassing the adapter to simulate
    // a hypothetical buggy code path that "forgot" the supersede.
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(scheduledPlanChanges).values({
        tenantId: tenant.ctx.slug,
        memberId,
        effectiveAtCycleId: cycleId,
        fromPlanId: 'p1',
        toPlanId: 'p2',
        scheduledByUserId: adminId,
        status: 'pending',
      });
    });

    // Second direct insert with status='pending' MUST be rejected by the
    // partial unique. Postgres surfaces SQLSTATE 23505 (unique_violation).
    let thrown: unknown = null;
    try {
      await runInTenant(tenant.ctx, async (tx) => {
        await tx.insert(scheduledPlanChanges).values({
          tenantId: tenant.ctx.slug,
          memberId,
          effectiveAtCycleId: cycleId,
          fromPlanId: 'p1',
          toPlanId: 'p3',
          scheduledByUserId: adminId,
          status: 'pending',
        });
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    // Postgres unique-violation. postgres-js wraps the original error
    // and exposes the SQLSTATE on the `cause` chain rather than the
    // top-level `.code` (varies by driver version), so we walk the chain.
    const seen = new Set<unknown>();
    let cause: unknown = thrown;
    let pgCode: string | undefined;
    let combinedMessage = '';
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      const rec = cause as { code?: string; message?: string; cause?: unknown };
      if (rec.code === '23505') pgCode = rec.code;
      if (rec.message) combinedMessage += rec.message + ' ';
      cause = rec.cause;
    }
    // Either the SQLSTATE 23505 surfaced somewhere on the chain OR the
    // partial unique name shows up in some error message in the chain.
    const matchedByCode = pgCode === '23505';
    const matchedByMessage =
      combinedMessage.includes('scheduled_plan_changes_pending_uniq') ||
      combinedMessage.toLowerCase().includes('duplicate key') ||
      combinedMessage.toLowerCase().includes('unique');
    expect(matchedByCode || matchedByMessage).toBe(true);
  }, 30_000);

  it('RLS+FORCE blocks tenantB from observing tenantA pending rows (cross-tenant probe)', async () => {
    const pair = await createTwoTestTenants();
    cleanups.push(pair.a.cleanup, pair.b.cleanup);
    const { a: tenantA, b: tenantB } = pair;

    // R2 Batch 3b-bis — seed member + renewal_cycle in tenantA
    // (migration 0125 FK chain).
    const { memberId, cycleId, ownerCleanup } = await seedMemberAndRenewalCycle({
      tenant: tenantA.ctx,
    });
    cleanups.push(ownerCleanup);
    const adminId = randomUUID();

    await drizzleScheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
      tenantA.ctx,
      {
        memberId,
        effectiveAtCycleId: cycleId,
        fromPlanId: 'p1',
        toPlanId: 'p2',
        scheduledByUserId: adminId,
      },
    );

    // tenantB cannot SELECT tenantA's row when running in tenantB's context.
    const tenantBView = await drizzleScheduledPlanChangeRepo.findPendingForCycle(
      tenantB.ctx,
      memberId,
      cycleId,
    );
    expect(tenantBView).toBeNull();

    // tenantA still sees its own row.
    const tenantAView = await drizzleScheduledPlanChangeRepo.findPendingForCycle(
      tenantA.ctx,
      memberId,
      cycleId,
    );
    expect(tenantAView).not.toBeNull();
    expect(tenantAView?.toPlanId).toBe('p2');

    // tenantB's listForMember returns nothing for the same memberId.
    const tenantBList = await drizzleScheduledPlanChangeRepo.listForMember(
      tenantB.ctx,
      memberId,
    );
    expect(tenantBList.length).toBe(0);
  }, 30_000);
});
