/**
 * 126 #7 — cancelScheduledPlanChange writes `plan_change_cancelled` in the
 * SAME tx as the cancel, so an audit failure rolls the cancel back.
 *
 * This file was R4-I9's regression net for the opposite contract (R3-S4:
 * the cancel committed, the audit was emitted after it, and the route
 * answered 200 + `X-Audit-Backfill-Required` so SRE could backfill). 126
 * supersedes that design — Constitution VIII: "Any database operation that
 * mutates more than one row or crosses aggregates MUST run inside a
 * transaction" — so the assertions are inverted, not deleted: the row stays
 * pending and no audit row exists.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { err, ok } from '@/lib/result';
import { cancelScheduledPlanChange } from '@/modules/plans/application/cancel-scheduled-plan-change';
import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo';
import { scheduledPlanChanges } from '@/modules/plans/infrastructure/db/schema-scheduled-plan-changes';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { AuditPort } from '@/modules/plans/application/ports';
import { createTestTenant } from '../helpers/test-tenant';
import { seedMemberAndRenewalCycle } from '../helpers/seed-renewal-cycle';

describe('Integration — cancelScheduledPlanChange audit-failed rolls back (126 #7, supersedes R4-I9)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) await fn();
  });

  it('126: the row stays pending and no audit row exists when the audit port fails', async () => {
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
    const failingAudit = {
      record: async () => {
        auditCallCount += 1;
        return err({ type: 'persist_failed' as const, message: 'simulated DB failure (126)' });
      },
      recordInTx: async () => {
        auditCallCount += 1;
        return err({ type: 'persist_failed' as const, message: 'simulated DB failure (126)' });
      },
    } as unknown as AuditPort;

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

    expect(auditCallCount).toBe(1);

    // audit_failed, and nothing to render: the cancel rolled back.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — audit-port must fail');
    expect(result.error.code).toBe('audit_failed');
    if (result.error.code !== 'audit_failed') throw new Error('unreachable');
    expect(result.error.message).toContain('simulated DB failure');

    // Direct-DB verification: the row is STILL pending.
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
    expect(dbRows[0]!.status).toBe('pending');
    expect(dbRows[0]!.cancelledAt).toBeNull();

    // Direct-DB verification: NO `plan_change_cancelled` audit row.
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
  });

  it('happy-path control — audit success path persists both the cancel + the audit row', async () => {
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
    const succeedingAudit = {
      record: async () => {
        auditCallCount += 1;
        return ok(undefined);
      },
      recordInTx: async () => {
        auditCallCount += 1;
        return ok(undefined);
      },
    } as unknown as AuditPort;

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
  });

  // R5-I8 — coverage parity for the `invalid_payload` audit-error
  // variant. The persist_failed branch above proves the row-persists
  // contract for one error type; this proves the same contract for
  // the zod-rejection branch (R3-I5 discriminator preserved end-to-end).
  it('R5-I8: row is cancelled in DB but audit row absent when audit-port returns invalid_payload', async () => {
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

    let auditCallCount = 0;
    const invalidPayloadAudit: AuditPort = {
      record: async (): Promise<
        Result<
          void,
          | { type: 'persist_failed'; message: string }
          | { type: 'invalid_payload'; issues: string[] }
        >
      > => {
        auditCallCount += 1;
        return err({
          type: 'invalid_payload' as const,
          issues: ['simulated zod rejection on payload.member_id'],
        });
      },
    };

    const result = await cancelScheduledPlanChange(
      {
        tenant: tenant.ctx,
        repo: drizzleScheduledPlanChangeRepo,
        audit: invalidPayloadAudit,
        actorUserId: adminUserId,
        requestId: 'r5-i8-invalid-payload-probe',
        sourceIp: null,
      },
      {
        scheduledChangeId,
        memberId,
        effectiveAtCycleId: cycleId,
        reason: null,
      },
    );

    expect(auditCallCount).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — invalid_payload must fail');
    expect(result.error.code).toBe('audit_failed');
    if (result.error.code !== 'audit_failed') throw new Error('unreachable');
    expect(result.error.auditErrorType).toBe('invalid_payload');
    expect(result.error.transitioned.status).toBe('cancelled');

    // Row IS cancelled despite the audit invalid_payload rejection.
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

    // No audit row exists — confirmed via tenant-scoped query.
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
  });
});
