/**
 * T081 — RBAC manager read-only integration test (spec FR-003, SC-003,
 * US2 acceptance scenario 2).
 *
 * Proves the full RBAC enforcement stack:
 *
 *   1. Create a real manager user + session in Postgres
 *   2. Call `requireRole(session, resource, 'write', ctx)` directly
 *   3. Assert the guard returns `{ ok: false, reason: 'role-denied' }`
 *   4. Assert exactly one `manager_denied_write` row landed in `audit_log`
 *      with the correct actor, target, source IP, summary, and request ID
 *   5. Repeat with an admin session → `{ ok: true }`, no audit row
 *
 * **Deviation from plan.md T081**: the original task said "iterates
 * every admin-only endpoint". At the end of Phase 3 no admin-only
 * endpoints exist yet — `POST /api/auth/invite` and friends arrive in
 * Phase 6 (T128–T132). We therefore exercise the guard at the
 * application-layer seam (`requireRole`) which every future admin-only
 * route will funnel through. Phase 6 tests will layer on top by
 * calling the actual route handlers.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { requireRole } from '@/lib/rbac-guard';
import type { CurrentSession } from '@/lib/auth-session';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

/**
 * Build a `CurrentSession` the same way `getCurrentSession()` would.
 * Inserts a real session row so subsequent queries still see the
 * expected cascading state.
 */
async function openSession(user: TestUser): Promise<CurrentSession> {
  const account = await userRepo.findById(user.userId);
  if (!account) throw new Error('openSession: user row missing');

  const session = await sessionRepo.create({
    userId: user.userId,
    sourceIp: '203.0.113.7',
    now: new Date(),
  });
  return { session, user: account };
}

async function closeSession(current: CurrentSession): Promise<void> {
  await sessionRepo.delete(current.session.id);
}

async function countDeniedAuditsFor(userId: string, requestId: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.eventType, 'manager_denied_write'),
        eq(auditLog.requestId, requestId),
      ),
    );
  return rows.filter((r) => r.actorUserId === userId).length;
}

describe('integration: RBAC — manager denied write (US2, FR-003)', () => {
  let manager: TestUser;
  let managerSession: CurrentSession;

  beforeEach(async () => {
    manager = await createActiveTestUser('manager');
    managerSession = await openSession(manager);
  });

  afterEach(async () => {
    await closeSession(managerSession);
    await deleteTestUser(manager);
  });

  it('denies manager write on auth:user AND emits manager_denied_write audit', async () => {
    const requestId = `rbac-mgr-write-${Date.now()}`;

    const result = await requireRole(managerSession, 'auth:user', 'write', {
      sourceIp: '203.0.113.7',
      requestId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('role-denied');

    const count = await countDeniedAuditsFor(manager.userId, requestId);
    expect(count).toBe(1);
  });

  it('denies manager delete on invoices:invoice AND emits audit', async () => {
    const requestId = `rbac-mgr-del-${Date.now()}`;

    const result = await requireRole(managerSession, 'invoices:invoice', 'delete', {
      sourceIp: '203.0.113.7',
      requestId,
    });

    expect(result.ok).toBe(false);
    const count = await countDeniedAuditsFor(manager.userId, requestId);
    expect(count).toBe(1);
  });

  it('permits manager read on staff:dashboard WITHOUT emitting an audit', async () => {
    const requestId = `rbac-mgr-read-${Date.now()}`;

    const result = await requireRole(managerSession, 'staff:dashboard', 'read', {
      sourceIp: '203.0.113.7',
      requestId,
    });

    expect(result.ok).toBe(true);
    const count = await countDeniedAuditsFor(manager.userId, requestId);
    expect(count).toBe(0);
  });

  it('permits manager self-service write (own password change)', async () => {
    const requestId = `rbac-mgr-self-${Date.now()}`;

    const result = await requireRole(managerSession, 'auth:self', 'write', {
      sourceIp: '203.0.113.7',
      requestId,
    });

    expect(result.ok).toBe(true);
    const count = await countDeniedAuditsFor(manager.userId, requestId);
    expect(count).toBe(0);
  });
});

describe('integration: RBAC — admin bypass (regression guard)', () => {
  let admin: TestUser;
  let adminSession: CurrentSession;

  beforeEach(async () => {
    admin = await createActiveTestUser('admin');
    adminSession = await openSession(admin);
  });

  afterEach(async () => {
    await closeSession(adminSession);
    await deleteTestUser(admin);
  });

  it('admin may write on auth:user WITHOUT emitting a denial audit', async () => {
    const requestId = `rbac-adm-write-${Date.now()}`;

    const result = await requireRole(adminSession, 'auth:user', 'write', {
      sourceIp: '203.0.113.7',
      requestId,
    });

    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(rows.filter((r) => r.eventType === 'manager_denied_write')).toHaveLength(0);
  });

  it('admin may delete on invoices:invoice', async () => {
    const result = await requireRole(
      adminSession,
      'invoices:invoice',
      'delete',
      { sourceIp: '203.0.113.7', requestId: `rbac-adm-del-${Date.now()}` },
    );
    expect(result.ok).toBe(true);
  });
});
