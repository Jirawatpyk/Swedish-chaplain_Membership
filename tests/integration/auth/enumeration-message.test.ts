/**
 * T058 — Integration test: response codes are identical across the
 * three authentication failure modes.
 *
 * Spec FR-016 + SC-019: the API MUST NOT reveal whether a failure
 * was caused by:
 *   (a) unknown email
 *   (b) known email + wrong password
 *   (c) pending (never-redeemed) account
 *
 * All three must return `{ error: 'invalid-credentials' }` with HTTP
 * 401 and NO extra hints in the response shape.
 *
 * Note: the latency dimension of the enumeration attack (p95 < 5 ms)
 * lives in T057 and is NOT asserted here — T057 is flaky in CI and is
 * deferred to the Polish phase.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { signIn } from '@/modules/auth/application/sign-in';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { asEmailAddress } from '@/modules/auth/domain/branded';

describe('integration: enumeration-safe failure responses', () => {
  let activeUser: TestUser;
  let pendingUserId: string;

  beforeEach(async () => {
    activeUser = await createActiveTestUser('admin');

    // Insert a second user in 'pending' status (no password hash yet).
    // Can't use the helper because it always sets status=active.
    const rand = Math.random().toString(36).slice(2, 10);
    const pendingEmail = asEmailAddress(`test-pending-${Date.now()}-${rand}@swecham.test`);
    const rows = await db
      .insert(users)
      .values({
        email: pendingEmail,
        role: 'admin',
        status: 'pending',
      })
      .returning({ id: users.id });
    pendingUserId = rows[0]!.id;
  });

  afterEach(async () => {
    await deleteTestUser(activeUser);
    await db.delete(users).where(eq(users.id, pendingUserId));
  });

  it('returns identical error shape for unknown / wrong-password / pending', async () => {
    // (a) unknown email
    const unknown = await signIn({
      email: `never-${Date.now()}@swecham.test`,
      password: 'anything',
      portal: 'staff',
      sourceIp: '203.0.113.30',
      requestId: `it-enum-a-${Date.now()}`,
    });

    // (b) known email, wrong password
    const wrongPw = await signIn({
      email: activeUser.rawEmail,
      password: 'wrong-password',
      portal: 'staff',
      sourceIp: '203.0.113.30',
      requestId: `it-enum-b-${Date.now()}`,
    });

    // (c) pending user
    const pendingRow = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, pendingUserId));
    const pending = await signIn({
      email: pendingRow[0]!.email,
      password: 'anything',
      portal: 'staff',
      sourceIp: '203.0.113.30',
      requestId: `it-enum-c-${Date.now()}`,
    });

    // All three MUST fail with the same error code
    expect(unknown.ok).toBe(false);
    expect(wrongPw.ok).toBe(false);
    expect(pending.ok).toBe(false);

    for (const result of [unknown, wrongPw, pending]) {
      if (result.ok) throw new Error('expected failure');
      expect(result.error.code).toBe('invalid-credentials');
      // The Err type for invalid-credentials has ONLY the `code` key;
      // any extra field would leak information. Assert the object
      // serialises to exactly `{ code: 'invalid-credentials' }`.
      expect(JSON.stringify(result.error)).toBe('{"code":"invalid-credentials"}');
    }
  });
});
