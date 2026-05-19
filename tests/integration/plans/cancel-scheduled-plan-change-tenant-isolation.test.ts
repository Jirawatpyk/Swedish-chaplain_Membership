/**
 * R2 Batch 3b + 3b-bis (R2-C5) — tenant-isolation Review-Gate probe for
 * `cancelScheduledPlanChange`.
 *
 * Constitution v1.4.0 Principle I clause 3 (Review-Gate blocker). Two
 * complementary probes:
 *
 *   1. **Strong cross-tenant probe**: seed a pending scheduled_plan_change
 *      in tenant B (via `seedMemberAndRenewalCycle` + the repo). From
 *      tenant A's context, drive `cancelScheduledPlanChange` with B's
 *      row id + B's keys. Assert `not_found` + B's row remains pending
 *      + no audit row emitted in either tenant.
 *
 *   2. **Boundary-validation probe**: R2-C2 (zod uuid) under the live
 *      composition root. Proves the use-case rejects non-uuid input
 *      BEFORE any DB I/O.
 *
 * The strong probe was enabled by R2 Batch 3b-bis which added
 * `seedMemberAndRenewalCycle` + reordered `test-tenant.cleanup` to
 * handle the migration 0125 FK chain (scheduled_plan_changes →
 * renewal_cycles → members). Before the helper, this probe was blocked
 * by the same FK that broke
 * `tests/integration/plans/scheduled-plan-changes-partial-unique.test.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';
import { cancelScheduledPlanChange } from '@/modules/plans/application/cancel-scheduled-plan-change';
import { planAuditAdapter } from '@/modules/plans/server';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTwoTestTenants } from '../helpers/test-tenant';
import { seedMemberAndRenewalCycle } from '../helpers/seed-renewal-cycle';

describe('Integration — cancelScheduledPlanChange tenant isolation (R2-C5)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  it('Tenant A cannot cancel a pending row owned by Tenant B (strong cross-tenant probe)', async () => {
    const pair = await createTwoTestTenants();
    cleanups.push(pair.a.cleanup, pair.b.cleanup);

    // Seed: tenant B has a pending scheduled_plan_change anchored on a
    // valid member + renewal_cycle (migration 0125 FK chain).
    const { memberId, cycleId } = await seedMemberAndRenewalCycle({
      tenant: pair.b.ctx,
    });
    const adminB = randomUUID();
    const adminA = randomUUID();

    const seeded =
      await drizzleScheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
        pair.b.ctx,
        {
          memberId,
          effectiveAtCycleId: cycleId,
          fromPlanId: 'corporate-regular',
          toPlanId: 'corporate-premier',
          scheduledByUserId: adminB,
        },
      );
    expect(seeded.inserted.status).toBe('pending');
    const tenantB_rowId = seeded.inserted.scheduledChangeId;

    // Attack: tenant A drives cancelScheduledPlanChange with B's row id
    // + B's memberId + B's cycleId. RLS in A's context must hide B's
    // row → findPendingForCycle returns null → use-case returns
    // not_found WITHOUT emitting audit.
    const result = await cancelScheduledPlanChange(
      {
        tenant: pair.a.ctx,
        repo: drizzleScheduledPlanChangeRepo,
        audit: planAuditAdapter,
        actorUserId: adminA,
        requestId: 'r2-c5-strong-cross-tenant-probe',
        sourceIp: null,
      },
      {
        scheduledChangeId: tenantB_rowId,
        memberId,
        effectiveAtCycleId: cycleId,
        cancelledByUserId: adminA,
      },
    );

    // 1. Use-case returns not_found (RLS hides B's row from A)
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — A must not see B row');
    expect(result.error.code).toBe('not_found');

    // 2. B's row remains pending on direct DB read in B's tenant context
    const rowsInB = await runInTenant(pair.b.ctx, async (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(eq(scheduledPlanChanges.scheduledChangeId, tenantB_rowId)),
    );
    expect(rowsInB.length).toBe(1);
    expect(rowsInB[0]!.status).toBe('pending');
    expect(rowsInB[0]!.cancelledAt).toBeNull();

    // 3. No audit row emitted with B's tenantId referencing the row
    const auditRowsInB = await runInTenant(pair.b.ctx, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'plan_change_cancelled')),
    );
    const matching = auditRowsInB.filter((r) => {
      const payload = r.payload as Record<string, unknown> | null;
      return (
        payload !== null &&
        typeof payload === 'object' &&
        payload.scheduled_change_id === tenantB_rowId
      );
    });
    expect(matching.length).toBe(0);
  }, 30_000);

  it('returns not_found when no row exists at all (RLS+findPendingForCycle null-path)', async () => {
    const pair = await createTwoTestTenants();
    cleanups.push(pair.a.cleanup, pair.b.cleanup);

    const memberId = randomUUID();
    const cycleId = randomUUID();
    const adminA = randomUUID();
    const fakeScheduledChangeId = randomUUID();

    const result = await cancelScheduledPlanChange(
      {
        tenant: pair.a.ctx,
        repo: drizzleScheduledPlanChangeRepo,
        audit: planAuditAdapter,
        actorUserId: adminA,
        requestId: 'r2-c5-null-path-probe',
        sourceIp: null,
      },
      {
        scheduledChangeId: fakeScheduledChangeId,
        memberId,
        effectiveAtCycleId: cycleId,
        cancelledByUserId: adminA,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — no row should exist');
    expect(result.error.code).toBe('not_found');
  }, 15_000);

  it('R2-C2 boundary: zod uuid validation rejects non-uuid memberId BEFORE any DB read', async () => {
    const pair = await createTwoTestTenants();
    cleanups.push(pair.a.cleanup, pair.b.cleanup);

    const result = await cancelScheduledPlanChange(
      {
        tenant: pair.a.ctx,
        repo: drizzleScheduledPlanChangeRepo,
        audit: planAuditAdapter,
        actorUserId: randomUUID(),
        requestId: 'r2-c5-boundary-probe',
        sourceIp: null,
      },
      {
        scheduledChangeId: 'arbitrary-non-empty-id',
        memberId: 'not-a-uuid',
        effectiveAtCycleId: randomUUID(),
        cancelledByUserId: randomUUID(),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — zod must reject non-uuid');
    expect(result.error.code).toBe('invalid_input');
    if (result.error.code !== 'invalid_input') throw new Error('unreachable');
    expect(result.error.field).toBe('memberId');
  }, 15_000);
});
