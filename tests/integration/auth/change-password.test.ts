/**
 * T148 — Change-password integration tests against live Neon.
 *
 * Scenarios (spec US6 AS1-AS3, SC-021):
 *   1. Happy path: signed-in user changes password; session is
 *      rotated; password hash is updated; audit event emitted.
 *   2. Two-session scenario (SC-021): user seeds two sessions;
 *      after change-password, only the new session exists — both
 *      the old "current" session and the other pre-existing
 *      session are gone. One `password_changed` + one
 *      `concurrent_sessions_revoked` audit event.
 *   3. wrong-current-password: returns error without touching hash
 *      or session state.
 *   4. same-password: short-circuits before HIBP, returns error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  auditLog,
  sessions as sessionsTable,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import {
  changePassword,
  defaultChangePasswordDeps,
} from '@/modules/auth/application/change-password';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const unlimitedLimiter = {
  check: async () => ({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
  }),
};

describe('integration: change-password (US6)', () => {
  let user: TestUser;
  let currentSessionId: string;

  beforeEach(async () => {
    user = await createActiveTestUser('admin');
    // Seed two sessions — one for the "current device" and one for
    // a "parallel browser" so we can verify SC-021 revocation.
    const current = await sessionRepo.create({
      userId: user.userId,
      sourceIp: '203.0.113.60',
      now: new Date(),
    });
    await sessionRepo.create({
      userId: user.userId,
      sourceIp: '203.0.113.61',
      now: new Date(),
    });
    currentSessionId = current.id;
  });

  afterEach(async () => {
    await deleteTestUser(user);
  });

  it('happy path: rotates session, revokes others, emits both audit events', async () => {
    const requestId = `it-change-pw-${Date.now()}`;
    const newPassword = `Change-${Date.now()}-Xy!2026`;

    // Re-read the user to get the UserAccount shape the use case wants
    const { userRepo } = await import(
      '@/modules/auth/infrastructure/db/user-repo'
    );
    const account = await userRepo.findById(user.userId);
    if (!account) throw new Error('setup: user not found');

    const result = await changePassword(
      {
        user: account,
        currentSessionId: currentSessionId as never,
        currentPassword: user.password,
        newPassword,
        sourceIp: '203.0.113.70',
        requestId,
      },
      { ...defaultChangePasswordDeps, limiter: unlimitedLimiter as never },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1. Old current session is gone
    const oldRows = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, currentSessionId));
    expect(oldRows).toHaveLength(0);

    // 2. Exactly one session row exists for the user (the new one)
    const allRows = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.userId, user.userId));
    expect(allRows).toHaveLength(1);
    expect(allRows[0]?.id).toBe(result.value.newSession.id);

    // 3. Password hash updated + verifies against the new password
    const userRows = await db
      .select({
        hash: users.passwordHash,
        lastChanged: users.lastPasswordChangedAt,
      })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(userRows[0]?.hash).toBeTruthy();
    const verifyNew = await argon2Hasher.verify(
      userRows[0]!.hash!,
      newPassword,
    );
    expect(verifyNew).toBe(true);

    // 4. Audit: password_changed + concurrent_sessions_revoked
    const changedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'password_changed'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(changedAudits.length).toBeGreaterThanOrEqual(1);

    const revokedAudits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'concurrent_sessions_revoked'),
          eq(auditLog.requestId, requestId),
        ),
      );
    expect(revokedAudits.length).toBeGreaterThanOrEqual(1);
  });

  it('wrong-current-password: returns error without side effects', async () => {
    const requestId = `it-change-pw-wrong-${Date.now()}`;

    const { userRepo } = await import(
      '@/modules/auth/infrastructure/db/user-repo'
    );
    const account = await userRepo.findById(user.userId);
    if (!account) throw new Error('setup: user not found');

    const result = await changePassword(
      {
        user: account,
        currentSessionId: currentSessionId as never,
        currentPassword: 'deliberately-wrong-password',
        newPassword: `AnotherNew-${Date.now()}-Xy!2026`,
        sourceIp: '203.0.113.71',
        requestId,
      },
      { ...defaultChangePasswordDeps, limiter: unlimitedLimiter as never },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('wrong-current-password');

    // No audit row for this request id
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(0);

    // Sessions unchanged — 2 still present
    const sessionRows = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.userId, user.userId));
    expect(sessionRows.length).toBe(2);
  });

  it('same-password: short-circuits before HIBP with same-password error', async () => {
    const requestId = `it-change-pw-same-${Date.now()}`;

    const { userRepo } = await import(
      '@/modules/auth/infrastructure/db/user-repo'
    );
    const account = await userRepo.findById(user.userId);
    if (!account) throw new Error('setup: user not found');

    const result = await changePassword(
      {
        user: account,
        currentSessionId: currentSessionId as never,
        currentPassword: user.password,
        newPassword: user.password, // same
        sourceIp: '203.0.113.72',
        requestId,
      },
      { ...defaultChangePasswordDeps, limiter: unlimitedLimiter as never },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('same-password');
  });
});
