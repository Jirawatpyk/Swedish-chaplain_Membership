/**
 * Integration: userEmailAdapter.isEmailVerifiedBatch (DV-11 code-review #7).
 *
 * Exercises the new batch read against live Neon:
 *   - verified + unverified mix → correct Set returned
 *   - empty input → ok(empty Set) WITHOUT a query
 *   - unknown userId → not included in the returned Set (not an error)
 *
 * `users` is cross-tenant; the adapter uses the global `db` pool.
 * Relies on live Neon via DATABASE_URL from .env.local — no mocks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { userEmailAdapter } from '@/modules/members/infrastructure/adapters/user-email-adapter';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

let verifiedUser: TestUser;
let unverifiedUser: TestUser;

beforeAll(async () => {
  verifiedUser = await createActiveTestUser('member');
  unverifiedUser = await createActiveTestUser('member');

  // Ensure verifiedUser.emailVerified = true
  await db
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, verifiedUser.userId));

  // Ensure unverifiedUser.emailVerified = false
  await db
    .update(users)
    .set({ emailVerified: false })
    .where(eq(users.id, unverifiedUser.userId));
}, 30_000);

afterAll(async () => {
  await deleteTestUser(verifiedUser);
  await deleteTestUser(unverifiedUser);
});

describe('userEmailAdapter.isEmailVerifiedBatch (DV-11 batch read)', () => {
  it('empty input → ok(empty Set) without a DB query', async () => {
    const result = await userEmailAdapter.isEmailVerifiedBatch([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(0);
    }
  });

  it('returns only the verified userId in the Set', async () => {
    const result = await userEmailAdapter.isEmailVerifiedBatch([
      verifiedUser.userId,
      unverifiedUser.userId,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has(verifiedUser.userId)).toBe(true);
    expect(result.value.has(unverifiedUser.userId)).toBe(false);
  });

  it('unknown userId is absent from the Set (not an error)', async () => {
    const ghostId = '00000000-0000-0000-0000-000000000000';
    const result = await userEmailAdapter.isEmailVerifiedBatch([
      verifiedUser.userId,
      ghostId,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has(verifiedUser.userId)).toBe(true);
    expect(result.value.has(ghostId)).toBe(false);
  });
});
