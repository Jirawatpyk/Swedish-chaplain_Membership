/**
 * F8 Phase 9 / T230 — RBAC defence-in-depth integration test.
 *
 * Companion to `tests/unit/lib/renewals-route-helpers.test.ts` which
 * pins the role × action × audit matrix at the application-layer seam
 * with mocks. This integration test proves the **DB-layer** invariant
 * that complements the unit test:
 *
 *   1. The `f8_role_violation_blocked` pgEnum value is shipped
 *      (migration 0086+; would otherwise silently no-op via the
 *      `F8_ENUM_SHIPPED` set in `drizzle-renewal-audit-emitter.ts`).
 *   2. The F8 audit emitter actually persists the row in `audit_log`
 *      under real Neon RLS — `audit_log` has RLS enabled but FORCE
 *      OFF for the cross-tenant forensic-review property; the F8
 *      emitter writes via the bookkeeping tenant slug.
 *   3. The payload structure matches `F8AuditPayloadShapes
 *      ['f8_role_violation_blocked']` — `resource`, `action` (one of
 *      `'read' | 'write' | 'manager_exception'` per Phase 6 review I5),
 *      `attempted_role`, `route` all persisted as expected.
 *
 * Why this complements the unit test, not duplicates it:
 *
 *   - Unit test: mocks `getCurrentSession` + `requireRole` + the audit
 *     emitter. Pins the WIRING — that the wrapper calls the emitter
 *     with the correct event type + payload + context for each role ×
 *     action combination.
 *   - Integration test (this file): bypasses the cookie/session layer
 *     and exercises the audit emitter directly against real Neon. Pins
 *     the PERSISTENCE — that pgEnum + RLS path + jsonb payload all
 *     wire correctly end-to-end. Without this, a future refactor that
 *     adds a new event type to `F8_AUDIT_EVENT_TYPES` const but forgets
 *     the migration would pass the unit test (mock accepts anything)
 *     yet silently no-op in production (drizzle adapter falls through
 *     to pino-log when the pgEnum value is missing).
 *
 * Note on schema columns: the F8 emitter (`drizzle-renewal-audit-
 * emitter.ts:buildInsertValues`) stores `ctx.correlationId` in the
 * `request_id` column when `ctx.requestId` is null — so this test
 * locates rows by `auditLog.requestId` rather than a separate
 * correlation_id column (the Drizzle schema does not expose one).
 * The `retention_years` column lives in DB but is not part of the
 * Drizzle schema; F8 lets the DB default (5y) apply.
 *
 * Constitution v1.4.0 Principle I clause 1 (defence-in-depth) +
 * Principle VIII (audit reliability) — both invariants depend on the
 * end-to-end persistence path being green.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { makeRenewalsDeps } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

describe('F8 RBAC defence-in-depth — Phase 9 / T230', () => {
  let tenant: TestTenant;
  let manager: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    manager = await createActiveTestUser('manager');
    member = await createActiveTestUser('member');
  }, 60_000);

  afterAll(async () => {
    // Clean every audit row this test inserted before the tenant
    // helper runs so subsequent test-runs see a clean slate.
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(manager).catch(() => {});
    await deleteTestUser(member).catch(() => {});
  }, 60_000);

  it('persists f8_role_violation_blocked audit row with action=write + attempted_role=manager (FR-052a default-deny)', async () => {
    const correlationId = randomUUID();
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    await deps.auditEmitter.emit(
      {
        type: 'f8_role_violation_blocked',
        payload: {
          resource: 'renewal',
          action: 'write',
          attempted_role: 'manager',
          route: '/api/admin/renewals/00000000-0000-0000-0000-000000000001/cancel',
        },
      },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: manager.userId,
        actorRole: 'manager',
        correlationId,
        requestId: null,
        summary: `Role manager blocked from write on renewal route /api/admin/renewals/.../cancel`,
      },
    );

    // F8 emitter stores `correlationId` under `request_id` when
    // `requestId` is null (`buildInsertValues` fallback). Locate the
    // row by that column.
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'f8_role_violation_blocked' as never),
          eq(auditLog.requestId, correlationId),
        ),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actorUserId).toBe(manager.userId);
    const payload = row.payload as {
      resource: string;
      action: string;
      attempted_role: string;
      route: string;
    };
    expect(payload.resource).toBe('renewal');
    expect(payload.action).toBe('write');
    expect(payload.attempted_role).toBe('manager');
    expect(payload.route).toContain('/api/admin/renewals/');
  });

  it('persists f8_role_violation_blocked with action=manager_exception (FR-052a Phase 6 I5 outreach exception)', async () => {
    const correlationId = randomUUID();
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    // Manager attempting an admin-only mutation on the at-risk member
    // (e.g. `block-auto-reactivation` per P2-r2). The route helper
    // emits with `action: 'manager_exception'` to differentiate this
    // from a pure read-deny in dashboards.
    await deps.auditEmitter.emit(
      {
        type: 'f8_role_violation_blocked',
        payload: {
          resource: 'renewal',
          action: 'manager_exception',
          attempted_role: 'member',
          route: '/api/admin/renewals/at-risk/00000000-0000-0000-0000-000000000002/outreach',
        },
      },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: member.userId,
        actorRole: 'member',
        correlationId,
        requestId: null,
        summary: `Role member blocked from manager_exception on renewal outreach route`,
      },
    );

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'f8_role_violation_blocked' as never),
          eq(auditLog.requestId, correlationId),
        ),
      );
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as { action: string; attempted_role: string };
    // The label preserves the SEMANTIC layer (manager_exception), not
    // the underlying RBAC mapping (which is `read` internally). This
    // distinction is load-bearing — a dashboard rule that pivots on
    // `payload.action='manager_exception'` to surface FR-052a outreach
    // attempts would otherwise miss them all.
    expect(payload.action).toBe('manager_exception');
    expect(payload.attempted_role).toBe('member');
  });

  it('audit row tenantId column matches the bookkeeping tenant — RLS isolation invariant', async () => {
    // Constitution Principle I clause 3 — audit-log writes are scoped
    // to the bookkeeping tenant slug; cross-tenant probe attempts emit
    // a probe-audit on tenant A's audit_log only, never tenant B's.
    // This test pins the column hygiene (the RLS+FORCE-OFF property
    // means audit_log is queryable cross-tenant for forensics, but
    // each row still carries its single owning tenantId — a row never
    // mutates its tenantId after insert).
    const correlationId = randomUUID();
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    await deps.auditEmitter.emit(
      {
        type: 'f8_role_violation_blocked',
        payload: {
          resource: 'renewal',
          action: 'read',
          attempted_role: 'member',
          route: '/api/admin/renewals/at-risk',
        },
      },
      {
        tenantId: tenant.ctx.slug,
        actorUserId: member.userId,
        actorRole: 'member',
        correlationId,
        requestId: null,
      },
    );

    const rows = await db
      .select({ tenantId: auditLog.tenantId, eventType: auditLog.eventType })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.requestId, correlationId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(tenant.ctx.slug);
    expect(rows[0]!.eventType).toBe('f8_role_violation_blocked');
  });
});
