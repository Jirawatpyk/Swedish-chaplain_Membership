/**
 * T-01 per-IP rate-limit integration test (security.md § 3 row T-01,
 * spec FR-016 rate-limiting).
 *
 * Distinct from `brute-force.test.ts` which covers the per-EMAIL
 * sliding window (5/15 min) against ONE target account. This test
 * covers the per-IP sliding window (30/15 min) against MANY target
 * accounts from one source — the credential-stuffing shape where the
 * attacker has a username/password list and walks it one email at a
 * time so the per-email bucket never fires.
 *
 * Expected behaviour (contracts/auth-api.md § 1 + research.md § 5):
 *   - Requests 1..30 may reach sign-in proper (pass the per-IP bucket).
 *   - Request 31+ SHOULD return `rate-limited` (HTTP 429 through the
 *     route handler; the use case returns `err({ code: 'rate-limited',
 *     retryAfterSeconds })`).
 *   - The `Retry-After` seconds value MUST be > 0 and <= the window.
 *
 * The REAL Upstash rate limiter is used (not a mock) so the test
 * exercises the production code path. Upstash keys are scanned and
 * deleted in afterEach so repeated runs start from a clean slate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { signIn, type SignInDeps } from '@/modules/auth/application/sign-in';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import { rateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { env } from '@/lib/env';

// Per-IP budget is 30 / 15 min (sign-in.ts RATE_LIMIT_PER_IP).
const PER_IP_BUDGET = 30;
const ATTEMPTS = PER_IP_BUDGET + 5; // 35 attempts — should see 5 rate-limited at tail
const ATTACKER_IP = '203.0.113.77';

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

describe('integration: per-IP rate limit (T-01 credential stuffing)', () => {
  let deps: SignInDeps;

  beforeEach(async () => {
    await clearSwechamKeys();
    deps = {
      users: userRepo,
      sessions: sessionRepo,
      audit: auditRepo,
      hasher: argon2Hasher,
      // REAL rate limiter — this is the point of the test.
      limiter: rateLimiter,
      now: () => new Date(),
    };
  });

  afterEach(async () => {
    await clearSwechamKeys();
  });

  it(
    `blocks stuffing: attempts > ${PER_IP_BUDGET} from one IP return rate-limited`,
    async () => {
      // Walk DISTINCT emails so the per-email bucket never maxes.
      // The target emails don't need to exist — `invalid-credentials`
      // is the expected outcome for the first PER_IP_BUDGET attempts
      // (sign-in.ts runs verifyDummy on the unknown-email path, then
      // returns invalid-credentials). Beyond the budget, the per-IP
      // rate limiter fires BEFORE the use case reaches user lookup,
      // so the response flips to rate-limited.
      const results: Array<{ ok: boolean; code?: string }> = [];

      for (let i = 0; i < ATTEMPTS; i += 1) {
        const result = await signIn(
          {
            email: `stuffing-target-${i}-${Date.now()}@swecham.test`,
            password: 'deliberately-wrong-password',
            portal: 'staff',
            sourceIp: ATTACKER_IP,
            requestId: `rate-limit-${i}-${Date.now()}`,
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
      const invalidCredentials = results.filter(
        (r) => r.code === 'invalid-credentials',
      ).length;

      console.log(
        `  stuffing results: ${ATTEMPTS} attempts → ` +
          `invalid-credentials=${invalidCredentials}, ` +
          `rate-limited=${rateLimited}`,
      );

      // 1. No sign-in should have succeeded — no real user exists for any of these.
      expect(results.filter((r) => r.ok).length).toBe(0);

      // 2. At least ATTEMPTS - PER_IP_BUDGET requests MUST be rate-limited.
      //    (Upstash sliding window may allow a few over the nominal budget
      //    depending on timing, so we use >= with a margin of 1.)
      expect(rateLimited).toBeGreaterThanOrEqual(ATTEMPTS - PER_IP_BUDGET - 1);

      // 3. The rate-limited responses must be the LAST attempts, not
      //    scattered across the run — the sliding window is monotonic.
      const firstRateLimitedIdx = results.findIndex(
        (r) => r.code === 'rate-limited',
      );
      expect(firstRateLimitedIdx).toBeGreaterThanOrEqual(PER_IP_BUDGET - 1);
    },
    { timeout: 120_000 },
  );

  it(
    'returns a positive Retry-After when the per-IP bucket is full',
    async () => {
      // Blast the IP budget first (so the next call is guaranteed rate-limited)…
      for (let i = 0; i < PER_IP_BUDGET; i += 1) {
        await signIn(
          {
            email: `warmup-${i}-${Date.now()}@swecham.test`,
            password: 'wrong',
            portal: 'staff',
            sourceIp: ATTACKER_IP,
            requestId: `warmup-${i}`,
          },
          deps,
        );
      }

      // …then fire one more and inspect the error payload.
      const result = await signIn(
        {
          email: `final-${Date.now()}@swecham.test`,
          password: 'wrong',
          portal: 'staff',
          sourceIp: ATTACKER_IP,
          requestId: `final-${Date.now()}`,
        },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('rate-limited');
      if (result.error.code !== 'rate-limited') return;
      // Retry-After must be positive and ≤ the 15-minute window.
      expect(result.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.error.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    },
    { timeout: 120_000 },
  );
});
