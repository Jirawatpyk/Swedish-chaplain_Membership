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
import { asPasswordHash } from '@/modules/auth/domain/branded';
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
  // B2 — change-password peek-then-consume; stub both.
  peek: async () => ({
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
    // E3 — DB row id is sha256(plaintext); newSession.id is plaintext.
    const { sha256Hex } = await import('@/lib/crypto');
    expect(allRows[0]?.id).toBe(sha256Hex(result.value.newSession.id));

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
      asPasswordHash(userRows[0]!.hash!),
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

    // B5 (post-ship 2026-05-17) — wrong-current-password now emits a
    // dedicated `password_change_failed` audit row so an attacker
    // probing a stolen session cookie has a forensic trail. Pre-B5
    // the audit was silent on this branch.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.requestId, requestId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.eventType).toBe('password_change_failed');

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

  // S-03 (staff review 2026-04-10) — close the integration-coverage
  // gap on the policy-fail and HIBP-breached branches. Both branches
  // are unit-tested in `password-policy.test.ts` but `changePassword`'s
  // end-to-end propagation of the `weak-password` error code was not
  // verified at the integration layer until now.
  it('weak-password: too-short new password is rejected with too-short reason', async () => {
    const requestId = `it-change-pw-short-${Date.now()}`;

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
        newPassword: 'tooShort1', // 9 chars — fails MIN_PASSWORD_LENGTH=12
        sourceIp: '203.0.113.73',
        requestId,
      },
      { ...defaultChangePasswordDeps, limiter: unlimitedLimiter as never },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('weak-password');
    if (result.error.code !== 'weak-password') return;
    const codes = result.error.errors.map((e) => e.code);
    expect(codes).toContain('too-short');

    // Side-effect assertion: password hash UNCHANGED
    const userRows = await db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.userId));
    const stillVerifies = await argon2Hasher.verify(
      asPasswordHash(userRows[0]!.hash!),
      user.password,
    );
    expect(stillVerifies).toBe(true);
  });

  it('weak-password: HIBP-breached new password is rejected with breached reason', async () => {
    const requestId = `it-change-pw-pwned-${Date.now()}`;

    const { userRepo } = await import(
      '@/modules/auth/infrastructure/db/user-repo'
    );
    const account = await userRepo.findById(user.userId);
    if (!account) throw new Error('setup: user not found');

    // Stub the policy check to simulate HIBP returning a positive
    // hit. Using a stub instead of the real HIBP API keeps the test
    // deterministic and avoids network flakiness.
    const stubBreachedPolicy = async () => ({
      ok: false as const,
      errors: [{ code: 'breached' as const, occurrences: 12345 }],
      strength: 'weak' as const,
    });

    const result = await changePassword(
      {
        user: account,
        currentSessionId: currentSessionId as never,
        currentPassword: user.password,
        newPassword: `LongAndUniqueButPretendBreached-${Date.now()}-Xy!`,
        sourceIp: '203.0.113.74',
        requestId,
      },
      {
        ...defaultChangePasswordDeps,
        limiter: unlimitedLimiter as never,
        checkPolicy: stubBreachedPolicy as never,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('weak-password');
    if (result.error.code !== 'weak-password') return;
    const codes = result.error.errors.map((e) => e.code);
    expect(codes).toContain('breached');

    // Side-effect assertion: password hash UNCHANGED
    const userRows = await db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.userId));
    const stillVerifies = await argon2Hasher.verify(
      asPasswordHash(userRows[0]!.hash!),
      user.password,
    );
    expect(stillVerifies).toBe(true);
  });
});
