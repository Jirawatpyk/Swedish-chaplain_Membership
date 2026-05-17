/**
 * T061 — Integration test: session ID is freshly generated on every
 * sign-in, never reused from a pre-existing cookie (security.md T-06).
 *
 * Scenario: a hypothetical attacker fixates a session ID by setting
 * the cookie before the victim signs in. When the victim signs in,
 * the server MUST issue a brand-new session ID — the pre-fixated one
 * must not become valid.
 *
 * We verify by signing in twice and asserting:
 *   1. Each sign-in produces a different session id
 *   2. Each session id is 64 hex chars (32 random bytes)
 *   3. Both rows exist in the sessions table (no automatic rotation
 *      on the sign-in path — other-session invalidation only happens
 *      on password change / role change / disable, spec FR-008)
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sessions } from '@/modules/auth/infrastructure/db/schema';
import { signIn } from '@/modules/auth/application/sign-in';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

describe('integration: session id rotation on sign-in', () => {
  let testUser: TestUser;

  beforeEach(async () => {
    testUser = await createActiveTestUser('admin');
  });

  afterEach(async () => {
    await deleteTestUser(testUser);
  });

  it('produces a fresh 64-hex id on every sign-in call', async () => {
    const first = await signIn({
      email: testUser.rawEmail,
      password: testUser.password,
      portal: 'staff',
      sourceIp: '203.0.113.40',
      requestId: `it-rotate-1-${Date.now()}`,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await signIn({
      email: testUser.rawEmail,
      password: testUser.password,
      portal: 'staff',
      sourceIp: '203.0.113.40',
      requestId: `it-rotate-2-${Date.now()}`,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const firstId = first.value.session.id;
    const secondId = second.value.session.id;

    expect(firstId).not.toBe(secondId);
    expect(firstId).toMatch(/^[0-9a-f]{64}$/);
    expect(secondId).toMatch(/^[0-9a-f]{64}$/);

    // Both session rows should be present — F1 does NOT revoke other
    // sessions on sign-in (that would defeat multi-device use).
    // E3 — DB row ids are sha256(plaintext); the values returned by
    // `signIn` are plaintexts (the cookie values).
    const { sha256Hex } = await import('@/lib/crypto');
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, testUser.userId));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(sha256Hex(firstId));
    expect(ids).toContain(sha256Hex(secondId));
  });
});
