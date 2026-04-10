/**
 * T138 + T139 — Member sign-in integration tests.
 *
 * Covers the two member-specific sign-in branches:
 *   1. Happy path: a member with portal='member' signs in successfully
 *      and the session is created with the member's role intact.
 *   2. Portal mismatch: a member trying to sign in via portal='staff'
 *      is rejected with the same generic `invalid-credentials` slug
 *      (spec FR-016 — no portal leak).
 *   3. Inverse: an admin trying portal='member' is also rejected.
 *
 * Runs against live Neon DB using the same TestUser helper as the
 * other F1 auth integration tests. A no-op rate limiter is injected
 * to avoid burning the shared Upstash bucket across repeated runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sessions, users } from '@/modules/auth/infrastructure/db/schema';
import { signIn } from '@/modules/auth/application/sign-in';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

const unlimitedLimiter = {
  check: async () => ({
    success: true,
    limit: 100,
    remaining: 99,
    reset: Date.now() + 60_000,
  }),
};

describe('integration: member sign-in (US5)', () => {
  let member: TestUser;

  beforeEach(async () => {
    member = await createActiveTestUser('member');
  });

  afterEach(async () => {
    await deleteTestUser(member);
  });

  it('member signing in via portal=member creates a session and succeeds', async () => {
    // Dynamic import to avoid circular typing with the DI override
    const result = await signIn(
      {
        email: member.rawEmail,
        password: member.password,
        portal: 'member',
        sourceIp: '203.0.113.50',
        requestId: `it-member-signin-${Date.now()}`,
      },
      {
        // Use defaults for everything except rate limiter
        users: (await import('@/modules/auth/infrastructure/db/user-repo')).userRepo,
        sessions: (await import('@/modules/auth/infrastructure/db/session-repo')).sessionRepo,
        audit: (await import('@/modules/auth/infrastructure/db/audit-repo')).auditRepo,
        hasher: (await import('@/modules/auth/infrastructure/password/argon2-hasher')).argon2Hasher,
        limiter: unlimitedLimiter as never,
        now: () => new Date(),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user.role).toBe('member');
    expect(result.value.session).toBeDefined();

    // Session row exists for this user
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, member.userId));
    expect(sessionRows.length).toBeGreaterThanOrEqual(1);
  });

  it('member signing in via portal=staff → invalid-credentials (FR-016 no portal leak)', async () => {
    const result = await signIn(
      {
        email: member.rawEmail,
        password: member.password,
        portal: 'staff',
        sourceIp: '203.0.113.51',
        requestId: `it-member-mismatch-${Date.now()}`,
      },
      {
        users: (await import('@/modules/auth/infrastructure/db/user-repo')).userRepo,
        sessions: (await import('@/modules/auth/infrastructure/db/session-repo')).sessionRepo,
        audit: (await import('@/modules/auth/infrastructure/db/audit-repo')).auditRepo,
        hasher: (await import('@/modules/auth/infrastructure/password/argon2-hasher')).argon2Hasher,
        limiter: unlimitedLimiter as never,
        now: () => new Date(),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Same generic message as any other wrong-credentials scenario
    expect(result.error.code).toBe('invalid-credentials');

    // No session row should have been created
    const userRows = await db
      .select({ lastSignIn: users.lastSignInAt })
      .from(users)
      .where(eq(users.id, member.userId));
    expect(userRows[0]?.lastSignIn).toBeNull();
  });
});

describe('integration: admin sign-in portal mismatch (regression guard)', () => {
  let admin: TestUser;

  beforeEach(async () => {
    admin = await createActiveTestUser('admin');
  });

  afterEach(async () => {
    await deleteTestUser(admin);
  });

  it('admin signing in via portal=member → invalid-credentials', async () => {
    const result = await signIn(
      {
        email: admin.rawEmail,
        password: admin.password,
        portal: 'member',
        sourceIp: '203.0.113.52',
        requestId: `it-admin-mismatch-${Date.now()}`,
      },
      {
        users: (await import('@/modules/auth/infrastructure/db/user-repo')).userRepo,
        sessions: (await import('@/modules/auth/infrastructure/db/session-repo')).sessionRepo,
        audit: (await import('@/modules/auth/infrastructure/db/audit-repo')).auditRepo,
        hasher: (await import('@/modules/auth/infrastructure/password/argon2-hasher')).argon2Hasher,
        limiter: unlimitedLimiter as never,
        now: () => new Date(),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-credentials');
  });
});
