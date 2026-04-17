/**
 * Integration: F3 sign-in security guards (FR-012a + FR-012b).
 *
 * Constitution Principle II requires 100% branch coverage on sign-in.
 * F3 added two new rejection branches:
 *   1. `emailVerified = false` — email change pending verification (FR-012a)
 *   2. `requiresPasswordReset = true` — email change reverted (FR-012b)
 *
 * Both must return `invalid-credentials` (same as wrong password) to
 * avoid leaking account state.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { signIn } from '@/modules/auth/application/sign-in';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

describe('integration: sign-in F3 security guards', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('member');
  });

  // Restore flags in afterEach — if an assertion fails, inline restore
  // would be skipped, leaking state to subsequent tests (TEST-2 fix).
  afterEach(async () => {
    await db
      .update(users)
      .set({ emailVerified: true, requiresPasswordReset: false })
      .where(eq(users.id, user.userId));
  });

  afterAll(async () => {
    await deleteTestUser(user);
  });

  it('rejects sign-in when emailVerified = false (FR-012a)', async () => {
    await db
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.id, user.userId));

    const result = await signIn({
      email: user.rawEmail,
      password: user.password,
      portal: 'member',
      sourceIp: '203.0.113.50',
      requestId: `it-f3-unverified-${Date.now()}`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-credentials');
    }
  }, 30_000);

  it('rejects sign-in when requiresPasswordReset = true (FR-012b)', async () => {
    await db
      .update(users)
      .set({ requiresPasswordReset: true })
      .where(eq(users.id, user.userId));

    const result = await signIn({
      email: user.rawEmail,
      password: user.password,
      portal: 'member',
      sourceIp: '203.0.113.51',
      requestId: `it-f3-reset-${Date.now()}`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-credentials');
    }
  }, 30_000);

  it('allows sign-in after flags are cleared', async () => {
    // Both flags should be in their default (passing) state from the
    // restores above — confirm sign-in works.
    const result = await signIn({
      email: user.rawEmail,
      password: user.password,
      portal: 'member',
      sourceIp: '203.0.113.52',
      requestId: `it-f3-clear-${Date.now()}`,
    });

    expect(result.ok).toBe(true);
  }, 30_000);
});
