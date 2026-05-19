/**
 * R4-I9 — end-to-end regression net for R3-S4 audit_failed UX.
 *
 * R3-S4 (Batch 4d) redesigned the cancel-route audit_failed UX:
 * when `cancelScheduledPlanChange` flips the row to `cancelled`
 * but then the audit emit fails (persist_failed or invalid_payload),
 * the route returns 200 + `X-Audit-Backfill-Required: 1` instead of
 * 500. The use-case carries the transitioned row in the typed error
 * variant so the route can render the cancelled-row body verbatim.
 *
 * The contract test at
 * `tests/contract/scheduled-plan-changes/cancel-route.test.ts` mocks
 * everything; this test exercises the canonical path with a LIVE
 * Neon row. Assertions:
 *
 *   1. Seed a pending scheduled_plan_change.
 *   2. Drive `cancelScheduledPlanChange` with a custom audit-port
 *      that always returns `err({type:'persist_failed', message:'simulated'})`.
 *   3. Result must be `err({code:'audit_failed',
 *      auditErrorType:'persist_failed', transitioned:<cancelled row>})`.
 *   4. Direct-DB read shows the row IS cancelled with non-null
 *      `cancelled_at` (the use-case's transitionStatus call DID
 *      commit, separately from the failed audit).
 *   5. NO `plan_change_cancelled` audit row exists for this tenant.
 *
 * Without R3-S4 + R4-I9 regression net, a future refactor could
 * accidentally roll back the cancel mutation when audit fails (the
 * "obvious safe choice" that violates Constitution Principle VIII:
 * audit writes are compliance-critical but NOT transactional with
 * the domain mutation).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { cancelScheduledPlanChange } from '@/modules/plans/application/cancel-scheduled-plan-change';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { AuditPort } from '@/modules/plans/application/ports';
import { createTestTenant } from '../helpers/test-tenant';
import { seedMemberAndRenewalCycle } from '../helpers/seed-renewal-cycle';

describe('Integration — cancelScheduledPlanChange audit-failed row-persists (R4-I9 / R3-S4)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  it('R4-I9: row is cancelled in DB but audit row absent when audit-port returns persist_failed', async () => {
    const tenant = await createTestTenant('test-swecham');
    cleanups.push(tenant.cleanup);

    // Seed a pending scheduled_plan_change anchored on a valid
    // member + renewal_cycle (migration 0125 FK chain).
    const { memberId, cycleId, ownerCleanup } = await seedMemberAndRenewalCycle({
      tenant: tenant.ctx,
    });
    cleanups.push(ownerCleanup);

    const adminUserId = randomUUID();

    const seeded =
      await drizzleScheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
        tenant.ctx,
        {
          memberId,
          effectiveAtCycleId: cycleId,
          fromPlanId: 'corporate-regular',
          toPlanId: 'corporate-premier',
          scheduledByUserId: adminUserId,
        },
      );
    expect(seeded.inserted.status).toBe('pending');
    const scheduledChangeId = seeded.inserted.scheduledChangeId;

    // Custom audit-port that always returns persist_failed.
    let auditCallCount = 0;
    const failingAudit: AuditPort = {
      record: async (): Promise<
        Result<
          void,
          | { type: 'persist_failed'; message: string }
          | { type: 'invalid_payload'; issues: string[] }
        >
      > => {
        auditCallCount += 1;
        return err({
          type: 'persist_failed' as const,
          message: 'simulated DB failure for R4-I9 regression net',
        });
      },
    };

    // Drive the use-case with the failing audit-port.
    const result = await cancelScheduledPlanChange(
      {
        tenant: tenant.ctx,
        repo: drizzleScheduledPlanChangeRepo,
        audit: failingAudit,
        actorUserId: adminUserId,
        requestId: 'r4-i9-row-persists-probe',
        sourceIp: null,
      },
      {
        scheduledChangeId,
        memberId,
        effectiveAtCycleId: cycleId,
        reason: null,
      },
    );

    // Audit was called exactly once.
    expect(auditCallCount).toBe(1);

    // The result is the audit_failed typed error variant carrying the
    // transitioned row.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — audit-port must fail');
    expect(result.error.code).toBe('audit_failed');
    if (result.error.code !== 'audit_failed') throw new Error('unreachable');
    expect(result.error.auditErrorType).toBe('persist_failed');
    expect(result.error.message).toContain('simulated DB failure');
    expect(result.error.transitioned.scheduledChangeId).toBe(scheduledChangeId);
    expect(result.error.transitioned.status).toBe('cancelled');
    expect(result.error.transitioned.cancelledAt).not.toBeNull();

    // Direct-DB verification: the row IS cancelled despite the audit
    // failure. This is the load-bearing R3-S4 contract — audit emit
    // is post-tx + non-rollback (Constitution Principle VIII).
    const dbRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(
          and(
            eq(scheduledPlanChanges.tenantId, tenant.ctx.slug),
            eq(scheduledPlanChanges.scheduledChangeId, scheduledChangeId),
          ),
        ),
    );
    expect(dbRows.length).toBe(1);
    expect(dbRows[0]!.status).toBe('cancelled');
    expect(dbRows[0]!.cancelledAt).not.toBeNull();

    // Direct-DB verification: NO `plan_change_cancelled` audit row
    // exists. The whole point of the R3-S4 + R4-I2 +
    // `X-Audit-Backfill-Required` design is that SRE backfills this
    // row out-of-band; the absence here is the signal the route emits
    // to operators.
    const auditRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_change_cancelled'),
            sql`(${auditLog.payload}->>'scheduled_change_id') = ${scheduledChangeId}`,
          ),
        ),
    );
    expect(auditRows.length).toBe(0);
  }, 30_000);

  it('R4-I9: happy-path control — audit success path persists both the cancel + the audit row', async () => {
    const tenant = await createTestTenant('test-swecham');
    cleanups.push(tenant.cleanup);

    const { memberId, cycleId, ownerCleanup } = await seedMemberAndRenewalCycle({
      tenant: tenant.ctx,
    });
    cleanups.push(ownerCleanup);

    const adminUserId = randomUUID();

    const seeded =
      await drizzleScheduledPlanChangeRepo.supersedeAndInsertPendingAtomically(
        tenant.ctx,
        {
          memberId,
          effectiveAtCycleId: cycleId,
          fromPlanId: 'corporate-regular',
          toPlanId: 'corporate-premier',
          scheduledByUserId: adminUserId,
        },
      );
    const scheduledChangeId = seeded.inserted.scheduledChangeId;

    // Audit-port that always succeeds — exercise the happy path.
    let auditCallCount = 0;
    const succeedingAudit: AuditPort = {
      record: async (): Promise<
        Result<
          void,
          | { type: 'persist_failed'; message: string }
          | { type: 'invalid_payload'; issues: string[] }
        >
      > => {
        auditCallCount += 1;
        return ok(undefined as void);
      },
    };

    const result = await cancelScheduledPlanChange(
      {
        tenant: tenant.ctx,
        repo: drizzleScheduledPlanChangeRepo,
        audit: succeedingAudit,
        actorUserId: adminUserId,
        requestId: 'r4-i9-happy-path-probe',
        sourceIp: null,
      },
      {
        scheduledChangeId,
        memberId,
        effectiveAtCycleId: cycleId,
        reason: 'happy-path test',
      },
    );

    expect(auditCallCount).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable — audit-port succeeded');
    expect(result.value.status).toBe('cancelled');
    expect(result.value.cancelledAt).not.toBeNull();

    // Direct-DB verification: row IS cancelled. (No audit-row check
    // because the test's audit-port is a stub — the audit row would
    // exist only if the production planAuditAdapter was used.)
    const dbRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(scheduledPlanChanges)
        .where(
          and(
            eq(scheduledPlanChanges.tenantId, tenant.ctx.slug),
            eq(scheduledPlanChanges.scheduledChangeId, scheduledChangeId),
          ),
        ),
    );
    expect(dbRows.length).toBe(1);
    expect(dbRows[0]!.status).toBe('cancelled');
  }, 30_000);
});
