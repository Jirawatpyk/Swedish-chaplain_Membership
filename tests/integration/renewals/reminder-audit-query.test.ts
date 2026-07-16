/**
 * F8 Round 2 review-fix (I-3) — `drizzleReminderAuditQueryRepo`
 * integration test (live Neon).
 *
 * Constitution v1.4.0 Principle I sub-clause 3 mandates a cross-tenant
 * integration test for every drizzle adapter touching tenanted data.
 * The new audit-existence repo (commit `d4afa438`) shipped without
 * one — this file closes that gap.
 *
 * What we verify on real Postgres:
 *
 *   1. Happy path — tenant A query with seeded T-7 + T-3 audit rows
 *      returns exactly the {T-7, T-3} set.
 *   2. **Cross-tenant isolation** — tenant B has its own audit rows
 *      with the SAME `cycle_id`; tenant A's query MUST NOT see them.
 *      The audit_log RLS policy is permissive (super-admin compliance
 *      visibility) so the explicit `WHERE tenant_id = ?` in the
 *      adapter is the ONLY guard. Without it, F8's catch-up logic
 *      would treat tenant B's audit rows as if they were tenant A's,
 *      silently suppressing tenant A's reminders.
 *   3. Cycle scoping — tenant A audit rows for a DIFFERENT cycle in
 *      the same tenant are excluded by the `payload->>'cycle_id'`
 *      JSONB filter.
 *   4. Empty result — a cycle with no audit rows yet returns an
 *      empty Set (NOT null/undefined) so the catch-up logic can fire
 *      every crossed rung on the first cron pass.
 *   5. Non-reminder audit rows in the same cycle (e.g.
 *      `lapsed_member_admin_reactivation_timed_out`) are NOT
 *      surfaced — the enum-array filter excludes them.
 *
 * Tests run on live Neon Singapore via DATABASE_URL from .env.local.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { auditLog, type AuditLogInsert } from '@/modules/auth/infrastructure/db/schema';
import { drizzleReminderAuditQueryRepo } from '@/modules/renewals/infrastructure/drizzle/drizzle-reminder-audit-query-repo';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

describe('F8 drizzleReminderAuditQueryRepo — integration (Round 2 I-3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  // Same cycle UUID across BOTH tenants — tests the cross-tenant
  // isolation guarantee. With permissive audit_log RLS, only the
  // explicit WHERE tenant_id filter prevents tenant A's query from
  // returning tenant B's rows.
  const sharedCycleId = randomUUID();
  // A second cycle in tenant A — tests cycle-id filtering scopes
  // results within a tenant.
  const otherCycleIdInA = randomUUID();

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Tenant A — sharedCycleId — T-7 + T-3 audit rows.
    // Tenant A — otherCycleIdInA — T-1 audit row (must NOT bleed).
    // Tenant A — sharedCycleId — `_timed_out` (NOT a reminder rung;
    //   must be excluded by enum-array filter).
    // Tenant B — sharedCycleId — T-7 + T-1 audit rows (cross-tenant
    //   bleed test).
    // Cast through `AuditLogInsert['eventType']` to bypass the TS-side
    // `pgEnum` schema definition (which omits the F8 reminder ladder
    // values added by migrations 0095/0099/0109 — production code uses
    // the same cast pattern at `drizzle-renewal-audit-emitter.ts:193`).
    type AuditEventType = AuditLogInsert['eventType'];
    const T7 =
      'lapsed_member_admin_reactivation_reminder_t-7' as AuditEventType;
    const T3 =
      'lapsed_member_admin_reactivation_reminder_t-3' as AuditEventType;
    const T1 =
      'lapsed_member_admin_reactivation_reminder_t-1' as AuditEventType;
    const TIMED_OUT =
      'lapsed_member_admin_reactivation_timed_out' as AuditEventType;

    const rows: AuditLogInsert[] = [
      {
        tenantId: tenantA.ctx.slug,
        eventType: T7,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant A T-7 for sharedCycleId',
        requestId: randomUUID(),
        payload: { cycle_id: sharedCycleId, member_id: randomUUID() },
      },
      {
        tenantId: tenantA.ctx.slug,
        eventType: T3,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant A T-3 for sharedCycleId',
        requestId: randomUUID(),
        payload: { cycle_id: sharedCycleId, member_id: randomUUID() },
      },
      {
        tenantId: tenantA.ctx.slug,
        eventType: T1,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant A T-1 for otherCycleIdInA',
        requestId: randomUUID(),
        payload: { cycle_id: otherCycleIdInA, member_id: randomUUID() },
      },
      {
        tenantId: tenantA.ctx.slug,
        eventType: TIMED_OUT,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant A timed_out for sharedCycleId — NOT a reminder rung',
        requestId: randomUUID(),
        payload: { cycle_id: sharedCycleId, member_id: randomUUID() },
      },
      {
        tenantId: tenantB.ctx.slug,
        eventType: T7,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant B T-7 for sharedCycleId — must NOT leak to tenant A query',
        requestId: randomUUID(),
        payload: { cycle_id: sharedCycleId, member_id: randomUUID() },
      },
      {
        tenantId: tenantB.ctx.slug,
        eventType: T1,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant B T-1 for sharedCycleId — must NOT leak to tenant A query',
        requestId: randomUUID(),
        payload: { cycle_id: sharedCycleId, member_id: randomUUID() },
      },
    ];
    await db.insert(auditLog).values(rows);
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('happy path: tenant A sees its own T-7 + T-3 for sharedCycleId', async () => {
    const result = await drizzleReminderAuditQueryRepo.findReminderAuditsForCycle(
      tenantA.ctx.slug,
      sharedCycleId,
    );
    expect(result.size).toBe(2);
    expect(result.has('lapsed_member_admin_reactivation_reminder_t-7')).toBe(true);
    expect(result.has('lapsed_member_admin_reactivation_reminder_t-3')).toBe(true);
    // Critical: T-1 from tenant B's row for the same cycleId MUST NOT
    // appear — the explicit WHERE tenant_id filter blocks it.
    expect(result.has('lapsed_member_admin_reactivation_reminder_t-1')).toBe(false);
  });

  it('cross-tenant isolation: tenant B sees its own T-7 + T-1 (NOT tenant A T-3)', async () => {
    const result = await drizzleReminderAuditQueryRepo.findReminderAuditsForCycle(
      tenantB.ctx.slug,
      sharedCycleId,
    );
    expect(result.size).toBe(2);
    expect(result.has('lapsed_member_admin_reactivation_reminder_t-7')).toBe(true);
    expect(result.has('lapsed_member_admin_reactivation_reminder_t-1')).toBe(true);
    // Tenant A had a T-3 row for sharedCycleId — must NOT bleed.
    expect(result.has('lapsed_member_admin_reactivation_reminder_t-3')).toBe(false);
  });

  it('cycle scoping: tenant A query with otherCycleIdInA sees only T-1', async () => {
    const result = await drizzleReminderAuditQueryRepo.findReminderAuditsForCycle(
      tenantA.ctx.slug,
      otherCycleIdInA,
    );
    expect(result.size).toBe(1);
    expect(result.has('lapsed_member_admin_reactivation_reminder_t-1')).toBe(true);
  });

  it('empty result: unseen cycle_id returns empty Set (not null/undefined)', async () => {
    const result = await drizzleReminderAuditQueryRepo.findReminderAuditsForCycle(
      tenantA.ctx.slug,
      randomUUID(),
    );
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(0);
  });

  it('non-reminder audits are excluded: tenant A sharedCycleId has a `_timed_out` row that does NOT surface', async () => {
    // The seed inserted a `lapsed_member_admin_reactivation_timed_out`
    // row for tenant A + sharedCycleId. The enum-array filter
    // (`event_type = ANY(ARRAY['_t-7','_t-3','_t-1']::audit_event_type[])`)
    // excludes it. Verified indirectly by happy-path assertion
    // above (size === 2, not 3) — but we re-check here explicitly
    // so the regression intent is documented.
    const result = await drizzleReminderAuditQueryRepo.findReminderAuditsForCycle(
      tenantA.ctx.slug,
      sharedCycleId,
    );
    // Only the reminder-ladder enum values can appear; `_timed_out`
    // is not even a member of `ReminderLadderAuditType` so the
    // type-system would reject `result.has('_timed_out')`. We assert
    // by negation via size — exactly 2 reminder rungs.
    expect(result.size).toBe(2);
  });
});

/**
 * 066 S3 — `findRenewalLapsedForCycle` integration (live Neon).
 *
 * The admin cycle-detail page reads the termination BASIS off the
 * `renewal_lapsed` audit payload. This proves the adapter:
 *   1. maps `termination_basis` + `due_date` off the JSONB payload;
 *   2. scopes by tenant (permissive audit_log RLS → the explicit
 *      `WHERE tenant_id` is the only guard, same as the reminder query);
 *   3. returns the LATEST row when a cycle lapsed more than once
 *      (e.g. re-lapse after a reactivation) — `ORDER BY timestamp DESC`;
 *   4. returns null for a cycle with no `renewal_lapsed` row.
 */
describe('066 findRenewalLapsedForCycle — integration (S3)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const lapsedCycleId = randomUUID();
  const backstopCycleId = randomUUID();

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    const LAPSED = 'renewal_lapsed' as AuditLogInsert['eventType'];
    const rows: AuditLogInsert[] = [
      // Tenant A — lapsedCycleId — an EARLIER lapse (no_invoice_backstop),
      // then a LATER lapse (due_plus_60). The adapter must return the later.
      {
        tenantId: tenantA.ctx.slug,
        eventType: LAPSED,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant A earlier lapse',
        requestId: randomUUID(),
        timestamp: new Date('2026-01-01T00:00:00Z'),
        payload: {
          cycle_id: lapsedCycleId,
          termination_basis: 'no_invoice_backstop',
          due_date: null,
        },
      },
      {
        tenantId: tenantA.ctx.slug,
        eventType: LAPSED,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant A later lapse (authoritative)',
        requestId: randomUUID(),
        timestamp: new Date('2026-03-01T00:00:00Z'),
        payload: {
          cycle_id: lapsedCycleId,
          termination_basis: 'due_plus_60',
          due_date: '2026-01-15',
        },
      },
      // Tenant A — backstopCycleId — a backstop lapse (null due_date).
      {
        tenantId: tenantA.ctx.slug,
        eventType: LAPSED,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant A backstop lapse',
        requestId: randomUUID(),
        payload: {
          cycle_id: backstopCycleId,
          termination_basis: 'no_invoice_backstop',
          due_date: null,
        },
      },
      // Tenant B — SAME lapsedCycleId — must NOT leak into tenant A's read.
      {
        tenantId: tenantB.ctx.slug,
        eventType: LAPSED,
        actorUserId: 'system:cron',
        targetUserId: null,
        summary: 'tenant B lapse for the shared cycle id',
        requestId: randomUUID(),
        payload: {
          cycle_id: lapsedCycleId,
          termination_basis: 'no_invoice_backstop',
          due_date: null,
        },
      },
    ];
    await db.insert(auditLog).values(rows);
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db
        .delete(auditLog)
        .where(eq(auditLog.tenantId, t.ctx.slug))
        .catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 120_000);

  it('returns the LATEST lapse basis + anchoring due_date for the cycle', async () => {
    const info = await drizzleReminderAuditQueryRepo.findRenewalLapsedForCycle(
      tenantA.ctx.slug,
      lapsedCycleId,
    );
    expect(info).toEqual({
      terminationBasis: 'due_plus_60',
      dueDate: '2026-01-15',
    });
  });

  it('maps the backstop basis with a null due_date', async () => {
    const info = await drizzleReminderAuditQueryRepo.findRenewalLapsedForCycle(
      tenantA.ctx.slug,
      backstopCycleId,
    );
    expect(info).toEqual({
      terminationBasis: 'no_invoice_backstop',
      dueDate: null,
    });
  });

  it('cross-tenant isolation: tenant B row for the shared cycle does not leak', async () => {
    // Tenant B seeded a `no_invoice_backstop` row for lapsedCycleId. If the
    // tenant filter failed, tenant B's row could win the ORDER BY and flip
    // the basis. Tenant A must still see its own `due_plus_60`.
    const info = await drizzleReminderAuditQueryRepo.findRenewalLapsedForCycle(
      tenantA.ctx.slug,
      lapsedCycleId,
    );
    expect(info?.terminationBasis).toBe('due_plus_60');
  });

  it('returns null for a cycle with no renewal_lapsed row', async () => {
    const info = await drizzleReminderAuditQueryRepo.findRenewalLapsedForCycle(
      tenantA.ctx.slug,
      randomUUID(),
    );
    expect(info).toBeNull();
  });
});
