/**
 * R3 Batch 4c (R3-I10) — live-Neon integration test for
 * `drizzleScheduledPlanChangeRepo.findById` covering terminal-row
 * hydration.
 *
 * Round 3 review flagged: the in-memory contract mock (`tests/contract/
 * f2-scheduled-plan-change.contract.test.ts:126-134`) and the
 * cross-tenant null-path probe both only exercise the null-return
 * + pending-row branches. Terminal-row hydration (`applied` /
 * `superseded` / `cancelled`) flows through `rowToDomain` →
 * `assertValidScheduledPlanChange` on real DB rows untested.
 *
 * Pinned contracts:
 *   1. Seed `pending` row → findById returns it with `status:'pending'`
 *      + all 3 terminal timestamps null.
 *   2. Transition to `applied` → findById returns `status:'applied'` +
 *      `appliedAt` set + supersededAt/cancelledAt null.
 *   3. Transition to `superseded` (via direct DB update) → findById
 *      returns `status:'superseded'` + correct timestamp.
 *   4. Transition to `cancelled` → same shape.
 *   5. `assertValidScheduledPlanChange` runs cleanly on every real
 *      DB row (no `InvalidScheduledPlanChangeError` thrown by
 *      `rowToDomain`).
 *   6. Cross-tenant: findById in tenant A's context returns null for
 *      a row owned by tenant B (RLS).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';
import { createTwoTestTenants } from '../helpers/test-tenant';
import { seedMemberAndRenewalCycle } from '../helpers/seed-renewal-cycle';

describe('Integration — drizzleScheduledPlanChangeRepo.findById terminal rows (R3-I10)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  it('hydrates pending row + applied row + superseded row + cancelled row cleanly through assertValidScheduledPlanChange', async () => {
    const pair = await createTwoTestTenants();
    cleanups.push(pair.a.cleanup, pair.b.cleanup);

    // Seed 4 separate (member, cycle) pairs — one for each status —
    // because the partial-unique constraint only permits ONE pending
    // row per (member, cycle).
    const seeds = await Promise.all([
      seedMemberAndRenewalCycle({ tenant: pair.a.ctx }),
      seedMemberAndRenewalCycle({ tenant: pair.a.ctx }),
      seedMemberAndRenewalCycle({ tenant: pair.a.ctx }),
      seedMemberAndRenewalCycle({ tenant: pair.a.ctx }),
    ]);
    for (const s of seeds) cleanups.push(s.ownerCleanup);

    const adminId = randomUUID();

    // Insert one pending per seed via the repo (canonical path).
    const inserts = await Promise.all(
      seeds.map((s) =>
        drizzleScheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
          pair.a.ctx,
          {
            memberId: s.memberId,
            effectiveAtCycleId: s.cycleId,
            fromPlanId: 'regular',
            toPlanId: 'premium',
            scheduledByUserId: adminId,
          },
        ),
      ),
    );
    const [pendingId, appliedId, supersededId, cancelledId] = inserts.map(
      (r) => r.inserted.scheduledChangeId,
    );

    // 1) pending — findById returns shape verbatim
    const pending = await drizzleScheduledPlanChangeRepo.findById(
      pair.a.ctx,
      pendingId!,
    );
    expect(pending).not.toBeNull();
    expect(pending?.status).toBe('pending');
    expect(pending?.appliedAt).toBeNull();
    expect(pending?.supersededAt).toBeNull();
    expect(pending?.cancelledAt).toBeNull();

    // 2) applied — transition + re-read
    await drizzleScheduledPlanChangeRepo.transitionStatus(
      pair.a.ctx,
      appliedId!,
      'applied',
    );
    const applied = await drizzleScheduledPlanChangeRepo.findById(
      pair.a.ctx,
      appliedId!,
    );
    expect(applied?.status).toBe('applied');
    expect(applied?.appliedAt).not.toBeNull();
    expect(applied?.supersededAt).toBeNull();
    expect(applied?.cancelledAt).toBeNull();

    // 3) superseded — transition + re-read
    await drizzleScheduledPlanChangeRepo.transitionStatus(
      pair.a.ctx,
      supersededId!,
      'superseded',
    );
    const superseded = await drizzleScheduledPlanChangeRepo.findById(
      pair.a.ctx,
      supersededId!,
    );
    expect(superseded?.status).toBe('superseded');
    expect(superseded?.supersededAt).not.toBeNull();
    expect(superseded?.appliedAt).toBeNull();
    expect(superseded?.cancelledAt).toBeNull();

    // 4) cancelled — transition + re-read
    await drizzleScheduledPlanChangeRepo.transitionStatus(
      pair.a.ctx,
      cancelledId!,
      'cancelled',
    );
    const cancelled = await drizzleScheduledPlanChangeRepo.findById(
      pair.a.ctx,
      cancelledId!,
    );
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.cancelledAt).not.toBeNull();
    expect(cancelled?.appliedAt).toBeNull();
    expect(cancelled?.supersededAt).toBeNull();

    // 5) Cross-tenant — findById in B's context for an A row returns
    // null (RLS hides it).
    const inB = await drizzleScheduledPlanChangeRepo.findById(
      pair.b.ctx,
      pendingId!,
    );
    expect(inB).toBeNull();
  }, 60_000);
});
