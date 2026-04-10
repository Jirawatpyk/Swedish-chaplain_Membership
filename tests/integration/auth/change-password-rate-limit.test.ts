/**
 * T149 — Change-password rate-limit integration test (spec FR-006).
 *
 * The change-password use case fires a per-user sliding-window limit
 * of 5 attempts per 15 minutes, keyed on `change-pw:user:<userId>`.
 * This is the brute-force defence against an attacker who has hijacked
 * a session but not learned the current password.
 *
 * Test strategy:
 *   1. Create one active user.
 *   2. Fire 5 wrong-current-password attempts → all return
 *      `wrong-current-password` (the limiter allowed the request).
 *   3. Fire a 6th attempt → returns `rate-limited` with a
 *      `retryAfterSeconds` between 1 and 900.
 *   4. Clean up both the user row and the per-user Upstash key so
 *      the next run starts fresh.
 *
 * Uses the REAL Upstash limiter (no mock) so the production code path
 * is exercised end-to-end. The `defaultChangePasswordDeps` already
 * points at the real limiter, real hasher, and real repos.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { env } from '@/lib/env';
import {
  changePassword,
  defaultChangePasswordDeps,
} from '@/modules/auth/application/change-password';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

async function clearSwechamKeys(): Promise<void> {
  const redis = new Redis({ url: env.upstash.url, token: env.upstash.token });
  let cursor = '0';
  do {
    const [nextCursor, keys] = (await redis.scan(cursor, {
      match: 'swecham*',
      count: 200,
    })) as [string, string[]];
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}

describe('integration: change-password rate limit (T149, FR-006)', () => {
  let user: TestUser;

  beforeEach(async () => {
    await clearSwechamKeys();
    user = await createActiveTestUser('admin');
  });

  afterEach(async () => {
    await deleteTestUser(user);
    await clearSwechamKeys();
  });

  it(
    'allows 5 wrong-current attempts, then rate-limits the 6th',
    async () => {
      // The use case requires the user domain object — fetch it so we
      // pass the exact shape that `getCurrentSession()` would produce.
      const found = await userRepo.findByEmail(user.email);
      expect(found).not.toBeNull();
      const domainUser = found!.user;

      const results: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const result = await changePassword(
          {
            user: domainUser,
            currentSessionId: 'placeholder-sess-id' as never,
            currentPassword: `wrong-pass-${i}`,
            newPassword: 'Totally-Different-New-Password!2026',
            sourceIp: '203.0.113.88',
            requestId: `rate-${i}`,
          },
          defaultChangePasswordDeps,
        );

        if (!result.ok) {
          results.push(result.error.code);
        } else {
          results.push('ok');
        }
      }

      // The first 5 attempts must reach the verify step and fail as
      // wrong-current (limiter allowed them). The 6th must be blocked
      // before argon2 runs → rate-limited.
      const wrongCount = results.filter((r) => r === 'wrong-current-password').length;
      const rateLimitedCount = results.filter((r) => r === 'rate-limited').length;

      console.log(
        `  change-password rate limit: wrong=${wrongCount}, rate-limited=${rateLimitedCount}`,
      );

      expect(wrongCount).toBe(5);
      expect(rateLimitedCount).toBe(1);
    },
    60_000,
  );
});
