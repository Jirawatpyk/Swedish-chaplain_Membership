/**
 * T056 — Integration test: sign-in happy path against a live DB.
 *
 * Proves the full stack works end-to-end:
 *   1. User row inserted via test helper
 *   2. `signIn()` use case called directly
 *   3. Session row created in `sessions`
 *   4. `last_sign_in_at` updated on the user
 *   5. `sign_in_success` audit event appended
 *
 * Requires `.env.local` with a valid DATABASE_URL (the
 * `vitest.integration.config.ts` loads it at config time). Run with
 * `pnpm test:integration`.
 */
import { and, desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { auditLog, sessions, users } from '@/modules/auth/infrastructure/db/schema';
import { signIn } from '@/modules/auth/application/sign-in';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

describe('integration: sign-in happy path', () => {
  let testUser: TestUser;

  beforeEach(async () => {
    testUser = await createActiveTestUser('admin');
  });

  afterEach(async () => {
    await deleteTestUser(testUser);
  });

  it('creates a session row, updates last_sign_in_at, emits sign_in_success', async () => {
    const before = new Date();

    const result = await signIn({
      email: testUser.rawEmail,
      password: testUser.password,
      portal: 'staff',
      sourceIp: '203.0.113.10',
      requestId: `it-signin-${Date.now()}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 1. Session row inserted
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, testUser.userId));

    expect(sessionRows).toHaveLength(1);
    // E3 — DB row id is sha256(plaintext); Session.id returned by the
    // repo is the plaintext (used as the cookie value).
    const { sha256Hex } = await import('@/lib/crypto');
    expect(sessionRows[0]?.id).toBe(sha256Hex(result.value.session.id));
    expect(sessionRows[0]?.sourceIp).toBe('203.0.113.10');

    // 2. last_sign_in_at updated on the user row
    const userRows = await db
      .select({ lastSignInAt: users.lastSignInAt, failedSignInCount: users.failedSignInCount })
      .from(users)
      .where(eq(users.id, testUser.userId));

    expect(userRows[0]?.lastSignInAt).not.toBeNull();
    expect(userRows[0]?.lastSignInAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(userRows[0]?.failedSignInCount).toBe(0);

    // 3. sign_in_success audit event appended for this user
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorUserId, testUser.userId), eq(auditLog.eventType, 'sign_in_success')),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(1);

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.summary).toContain('staff');
  });

  it('wrong password returns invalid-credentials and increments failed count', async () => {
    const result = await signIn({
      email: testUser.rawEmail,
      password: 'definitely-not-the-password',
      portal: 'staff',
      sourceIp: '203.0.113.11',
      requestId: `it-signin-wrong-${Date.now()}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-credentials');

    const userRows = await db
      .select({ failedSignInCount: users.failedSignInCount })
      .from(users)
      .where(eq(users.id, testUser.userId));

    expect(userRows[0]?.failedSignInCount).toBe(1);
  });

  it('unknown email returns invalid-credentials without creating any session', async () => {
    const result = await signIn({
      email: `nope-${Date.now()}@swecham.test`,
      password: 'whatever',
      portal: 'staff',
      sourceIp: '203.0.113.12',
      requestId: `it-signin-unknown-${Date.now()}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-credentials');

    // No session for the test user (proves the call did NOT inadvertently
    // sign someone in)
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, testUser.userId));
    expect(sessionRows).toHaveLength(0);
  });

  // S-02 (staff review 2026-04-10) — close the integration-coverage
  // gap on the disabled-user branch. Previously the only test for this
  // path was the contract test (`tests/contract/sign-in.test.ts`)
  // with a fully mocked use case, which leaves the use-case branch
  // itself unverified against live Neon. Constitution Principle II
  // requires 100% branch coverage on sign-in at the integration level.
  it('disabled user returns account-disabled and does not create a session', async () => {
    // Disable the bee-pre-existing test user via the live repo. We
    // import lazily to avoid loading the repo at module init.
    const { userRepo } = await import(
      '@/modules/auth/infrastructure/db/user-repo'
    );
    await userRepo.disable(testUser.userId);

    const result = await signIn({
      email: testUser.rawEmail,
      password: testUser.password, // correct password — we want the disabled branch
      portal: 'staff',
      sourceIp: '203.0.113.13',
      requestId: `it-signin-disabled-${Date.now()}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('account-disabled');

    // Sanity: no session row created for the disabled user
    const sessionRows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, testUser.userId));
    expect(sessionRows).toHaveLength(0);
  });
});
