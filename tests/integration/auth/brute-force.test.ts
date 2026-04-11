/**
 * T059 — Brute-force rate-limit integration test
 * (security.md T-02, spec SC-010).
 *
 * Attack model: an attacker fires many sign-in attempts from one
 * source, hoping that a small fraction will succeed OR that the
 * CPU cost of argon2 will take the server offline.
 *
 * Our defense is layered:
 *   1. Upstash sliding-window rate limit per email  (5 / 15 min)
 *   2. Upstash sliding-window rate limit per IP     (30 / 15 min)
 *   3. Application-level lockout on the user row    (5 failures)
 *
 * This test fires 50 wrong-password attempts at a single known user
 * from a single IP and counts how many actually reached argon2
 * verify. The spec SC-010 budget is "≤ 10 reach argon2"; with the
 * 5/15-min per-email threshold, we expect ~5 argon2 invocations.
 *
 * The per-email rate limit fires BEFORE the hasher in the code path,
 * so attempts 6+ short-circuit in the sign-in use case and never
 * touch CPU. We verify this by injecting a counting hasher wrapper
 * around the real `argon2Hasher` and asserting the call count.
 *
 * The REAL Upstash rate limiter is used (not a mock) so the test
 * exercises the production code path. Keys are cleaned up in
 * `afterEach` via `scripts/clear-rate-limit.ts` so repeated runs
 * start from a clean slate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { signIn, type SignInDeps } from '@/modules/auth/application/sign-in';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import {
  argon2Hasher,
  type PasswordHasher,
} from '@/modules/auth/infrastructure/password/argon2-hasher';
import type { PasswordHash } from '@/modules/auth/domain/branded';
import { rateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { env } from '@/lib/env';

const ATTEMPTS = 50;
const EXPECTED_ARGON2_UPPER_BOUND = 10;

class CountingHasher implements PasswordHasher {
  verifyCalls = 0;
  verifyDummyCalls = 0;

  async hash(pw: string): Promise<PasswordHash> {
    return argon2Hasher.hash(pw);
  }
  async verify(hashed: PasswordHash, pw: string): Promise<boolean> {
    this.verifyCalls += 1;
    return argon2Hasher.verify(hashed, pw);
  }
  async verifyDummy(pw: string): Promise<void> {
    this.verifyDummyCalls += 1;
    return argon2Hasher.verifyDummy(pw);
  }
}

async function clearSwechamKeys(): Promise<void> {
  const redis = new Redis({ url: env.upstash.url, token: env.upstash.token });
  let cursor = '0';
  do {
    const [nextCursor, keys] = (await redis.scan(cursor, { match: 'swecham*', count: 200 })) as [
      string,
      string[],
    ];
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}

describe('integration: brute-force rate limit', () => {
  let testUser: TestUser;
  let countingHasher: CountingHasher;
  let deps: SignInDeps;

  beforeEach(async () => {
    // Ensure the Upstash buckets are clean so previous tests don't
    // bleed into this one (the per-email bucket in particular).
    await clearSwechamKeys();
    testUser = await createActiveTestUser('admin');
    countingHasher = new CountingHasher();
    deps = {
      users: userRepo,
      sessions: sessionRepo,
      audit: auditRepo,
      hasher: countingHasher,
      // REAL rate limiter — this is the whole point of the test.
      limiter: rateLimiter,
      now: () => new Date(),
    };
  });

  afterEach(async () => {
    await deleteTestUser(testUser);
    // Clean up again so next test starts fresh.
    await clearSwechamKeys();
  });

  it(
    `blocks brute-force: ≤ ${EXPECTED_ARGON2_UPPER_BOUND} argon2 calls across ${ATTEMPTS} attempts`,
    async () => {
      const results: Array<{ ok: boolean; code?: string }> = [];

      for (let i = 0; i < ATTEMPTS; i += 1) {
        const result = await signIn(
          {
            email: testUser.rawEmail,
            password: 'deliberately-wrong-password-for-brute-force-test',
            portal: 'staff',
            sourceIp: '203.0.113.60',
            requestId: `brute-${i}-${Date.now()}`,
          },
          deps,
        );

        if (result.ok) {
          results.push({ ok: true });
        } else {
          results.push({ ok: false, code: result.error.code });
        }
      }

      const rateLimited = results.filter((r) => r.code === 'rate-limited').length;
      const invalidCredentials = results.filter((r) => r.code === 'invalid-credentials').length;
      const accountLocked = results.filter((r) => r.code === 'account-locked').length;

      console.log(
        `  brute-force results: ${ATTEMPTS} attempts → ` +
          `invalid-credentials=${invalidCredentials}, ` +
          `account-locked=${accountLocked}, ` +
          `rate-limited=${rateLimited}, ` +
          `argon2 calls=${countingHasher.verifyCalls}`,
      );

      // No attempt should have succeeded
      expect(results.filter((r) => r.ok).length).toBe(0);

      // The core assertion: the CPU cost of argon2 was paid at most
      // EXPECTED_ARGON2_UPPER_BOUND times, regardless of how many
      // requests hit the API. This proves the defense-in-depth layers
      // (email rate limit + IP rate limit + lockout) kick in before
      // the hasher.
      expect(countingHasher.verifyCalls).toBeLessThanOrEqual(EXPECTED_ARGON2_UPPER_BOUND);

      // Most attempts should have been rate-limited
      expect(rateLimited).toBeGreaterThan(ATTEMPTS - EXPECTED_ARGON2_UPPER_BOUND - 5);
    },
    { timeout: 60_000 },
  );
});
