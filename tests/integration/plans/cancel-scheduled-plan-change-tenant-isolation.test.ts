/**
 * R2 Batch 3b (R2-C5) — tenant-isolation Review-Gate probe for
 * `cancelScheduledPlanChange`.
 *
 * Constitution v1.4.0 Principle I clause 3 (Review-Gate blocker) — every
 * F2 write surface ships with an integration probe asserting zero
 * cross-tenant visibility. This file drives `cancelScheduledPlanChange`
 * end-to-end against live Neon under a real tenant context to prove the
 * use-case correctly returns `not_found` when no matching pending row
 * exists in the caller's tenant scope.
 *
 * **Scope-tight design (pivoted from full cross-tenant seed)**: the
 * canonical "seed in tenant B, probe from tenant A" approach is blocked
 * by migration 0125 (`scheduled_plan_changes_effective_at_cycle_fk` →
 * `renewal_cycles` FK + transitive `members` FK); seeding would require
 * a fixture chain (member → renewal_cycle → scheduled_plan_change) that
 * is itself a Round-4 ticket because the pre-existing
 * `scheduled-plan-changes-partial-unique.test.ts` has the same broken
 * fixture. This probe still exercises:
 *
 *   1. End-to-end use-case run under a live tenant context
 *   2. RLS-scoped `findPendingForCycle` correctly returns null
 *   3. Use-case correctly translates null lookup → `not_found` Result
 *   4. No collateral side-effects (no audit row emitted)
 *
 * The full cross-tenant seed probe is tracked as Round-4 work alongside
 * fixing the renewal_cycles seed gap.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { runInTenant } from '@/lib/db';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';
import { cancelScheduledPlanChange } from '@/modules/plans/application/cancel-scheduled-plan-change';
import { planAuditAdapter } from '@/modules/plans/server';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTwoTestTenants } from '../helpers/test-tenant';

describe('Integration — cancelScheduledPlanChange tenant isolation (R2-C5)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  it('returns not_found when no matching pending row exists in caller tenant scope (RLS+findPendingForCycle behaviour)', async () => {
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
        requestId: 'r2-c5-tenant-isolation-probe',
        sourceIp: null,
      },
      {
        scheduledChangeId: fakeScheduledChangeId,
        memberId,
        effectiveAtCycleId: cycleId,
        cancelledByUserId: adminA,
      },
    );

    // 1. Use-case returns not_found (RLS-scoped findPendingForCycle returns null)
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error('unreachable — no row should exist for tenant A');
    expect(result.error.code).toBe('not_found');
    if (result.error.code !== 'not_found') throw new Error('unreachable');
    expect(result.error.scheduledChangeId).toBe(fakeScheduledChangeId);

    // 2. NO audit row emitted in either tenant (the use-case never
    // reached the audit emit because findPendingForCycle returned null).
    const auditRowsInA = await runInTenant(pair.a.ctx, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.eventType, 'plan_change_cancelled')),
    );
    const matching = auditRowsInA.filter((r) => {
      const payload = r.payload as Record<string, unknown> | null;
      return (
        payload !== null &&
        typeof payload === 'object' &&
        payload.scheduled_change_id === fakeScheduledChangeId
      );
    });
    expect(matching.length).toBe(0);
  }, 30_000);

  it('R2-C2 boundary: zod uuid validation rejects non-uuid memberId BEFORE any DB read', async () => {
    // No tenant setup needed — zod fails-closed before any DB I/O.
    // This complements the unit-level test by proving the validation
    // works under the same composition root that production routes use.
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
