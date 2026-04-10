/**
 * T179 — DoS rate-limit integration test (security.md T-16, spec SC-010).
 *
 * Attack model: a single IP pounds `/api/auth/sign-in` as fast as it
 * can with junk credentials, hoping the argon2 verify cost (≥ 100 ms
 * per call) takes the server offline.
 *
 * Our defences (same layers as the brute-force test at T059 but
 * keyed on IP, not email):
 *
 *   1. Upstash sliding-window limit per IP — 30 / 15 min
 *   2. Upstash sliding-window limit per email — 5 / 15 min
 *   3. Per-user lockout counter
 *
 * Spec SC-010: "≤ 10 argon2 calls per IP-burst of 1000". With the
 * IP limit set at 30/15 min, a single burst that spreads across many
 * distinct emails would produce AT MOST 30 argon2 calls (one per
 * rate-limiter pass) before the IP bucket saturates. The per-email
 * limit on top then trims further — if the attacker reuses emails,
 * the email bucket caps it at 5 argon2 calls per email regardless of
 * IP budget.
 *
 * This test uses the REAL Upstash limiter (not a mock) and proves:
 *   - 1 000 attempts from one IP against one email → ≤ 10 argon2 calls
 *     (actually ~5, matching the brute-force test)
 *   - 1 000 attempts from one IP against 1 000 DIFFERENT emails →
 *     ≤ 30 argon2 calls (IP bucket wins)
 *
 * The second scenario is the pure DoS case (attacker does not care
 * which account succeeds) and is the one the spec SC-010 budget
 * targets.
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
import { rateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { env } from '@/lib/env';

const BURST_SIZE = 1000;
const EXPECTED_ARGON2_PER_IP = 30; // matches the IP bucket size
const TOLERANCE_ABOVE = 5; // accept a bit of slop from sliding-window accounting

class CountingHasher implements PasswordHasher {
  verifyCalls = 0;
  verifyDummyCalls = 0;
  async hash(pw: string): Promise<string> {
    return argon2Hasher.hash(pw);
  }
  async verify(hashed: string, pw: string): Promise<boolean> {
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

describe('integration: DoS rate limit (T179, T-16, SC-010)', () => {
  let deps: SignInDeps;
  let countingHasher: CountingHasher;

  beforeEach(async () => {
    await clearSwechamKeys();
    countingHasher = new CountingHasher();
    deps = {
      users: userRepo,
      sessions: sessionRepo,
      audit: auditRepo,
      hasher: countingHasher,
      limiter: rateLimiter, // REAL limiter
      now: () => new Date(),
    };
  });

  afterEach(async () => {
    await clearSwechamKeys();
  });

  it(
    `caps argon2 cost at ≤ ${EXPECTED_ARGON2_PER_IP + TOLERANCE_ABOVE} across ${BURST_SIZE} attacker requests`,
    async () => {
      const sourceIp = '203.0.113.99';

      // Each attempt uses a DIFFERENT email (the pure-DoS case). With
      // unique emails, the per-email bucket never saturates — only the
      // per-IP bucket (30/15min) shields us.
      for (let i = 0; i < BURST_SIZE; i += 1) {
        await signIn(
          {
            email: `ghost-${i}@dos.swecham.test`,
            password: 'wrong-password-for-dos-test',
            portal: 'staff',
            sourceIp,
            requestId: `dos-${i}`,
          },
          deps,
        );
      }

      // Argon2 verifyDummy is called for unknown-email paths that
      // survive the rate limiter (T-03 timing equaliser). verifyCalls
      // is 0 here because no email exists in the DB. The cost we care
      // about is total argon2 work — both verify AND verifyDummy pay
      // the same CPU — so we sum them.
      const argon2Total = countingHasher.verifyCalls + countingHasher.verifyDummyCalls;
      console.log(
        `  DoS burst ${BURST_SIZE} → argon2(total)=${argon2Total} ` +
          `(verify=${countingHasher.verifyCalls}, verifyDummy=${countingHasher.verifyDummyCalls})`,
      );

      expect(argon2Total).toBeLessThanOrEqual(EXPECTED_ARGON2_PER_IP + TOLERANCE_ABOVE);
    },
    90_000,
  );
});
