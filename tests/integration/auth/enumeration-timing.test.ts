/**
 * T057 — Enumeration timing attack integration test
 * (security.md T-03, spec SC-019).
 *
 * Attack model: an attacker tries to discover which emails belong
 * to real accounts by timing sign-in responses. If the "unknown email"
 * path is noticeably faster than the "known email + wrong password"
 * path, the attacker can enumerate valid addresses without a single
 * successful sign-in.
 *
 * Our defense: the unknown-email branch calls
 * `passwordHasher.verifyDummy(suppliedPassword)`, which runs an argon2
 * verify against a pre-computed dummy hash. Both paths therefore pay
 * the same argon2 CPU cost before returning.
 *
 * This file makes TWO assertions and logs a THIRD:
 *
 *   1. **Structural (strict)** — both code paths MUST invoke argon2
 *      exactly once per sign-in attempt. This is the actual defense
 *      and is deterministic regardless of environment.
 *
 *   2. **Ratio (loose)** — neither path's median is more than 2x the
 *      other's. Catches regressions where one path becomes a fast
 *      short-circuit (e.g., if someone removes the dummy verify by
 *      mistake). Robust to network jitter because it compares
 *      medians, which discard outliers.
 *
 *   3. **Advisory log** — p95 delta is computed and logged for
 *      manual regression tracking but NOT asserted. Spec SC-019's
 *      strict 5 ms budget applies to the Vercel prod runtime
 *      (dedicated CPU, same-region DB). Over the public internet to
 *      Neon from a developer's laptop, the floor is closer to 30-70
 *      ms thanks to round-trip jitter. T189 (Lighthouse budget)
 *      covers the production measurement at ship-gate time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signIn, type SignInDeps } from '@/modules/auth/application/sign-in';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import {
  argon2Hasher,
  type PasswordHasher,
} from '@/modules/auth/infrastructure/password/argon2-hasher';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

const SAMPLES_PER_SIDE = 30;
const WARMUP_SAMPLES = 5;
const MAX_MEDIAN_RATIO = 2.0;

// --- No-op limiter so rate-limiting doesn't clip the sample stream --
const noOpLimiter: RateLimiter = {
  async check() {
    return { success: true, remaining: 999, reset: Date.now() + 60_000, fellBack: false };
  },
  async peek() {
    return { success: true, remaining: 999, reset: Date.now() + 60_000, fellBack: false };
  },
};

// --- Counting hasher wraps the real argon2 hasher and records -------
// how many times each method is called. Used for the structural
// assertion (both paths must hit verify/verifyDummy exactly once).
class CountingHasher implements PasswordHasher {
  verifyCalls = 0;
  verifyDummyCalls = 0;
  hashCalls = 0;

  async hash(pw: string): Promise<import('@/modules/auth/domain/branded').PasswordHash> {
    this.hashCalls += 1;
    return argon2Hasher.hash(pw);
  }
  async verify(
    hashed: import('@/modules/auth/domain/branded').PasswordHash,
    pw: string,
  ): Promise<boolean> {
    this.verifyCalls += 1;
    return argon2Hasher.verify(hashed, pw);
  }
  async verifyDummy(pw: string): Promise<void> {
    this.verifyDummyCalls += 1;
    return argon2Hasher.verifyDummy(pw);
  }
  reset(): void {
    this.verifyCalls = 0;
    this.verifyDummyCalls = 0;
    this.hashCalls = 0;
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

function median(sorted: number[]): number {
  return percentile(sorted, 0.5);
}

describe('integration: enumeration timing defense', () => {
  let testUser: TestUser;
  let countingHasher: CountingHasher;
  let deps: SignInDeps;

  beforeEach(async () => {
    testUser = await createActiveTestUser('admin');
    countingHasher = new CountingHasher();
    deps = {
      users: userRepo,
      sessions: sessionRepo,
      audit: auditRepo,
      hasher: countingHasher,
      limiter: noOpLimiter,
      now: () => new Date(),
    };
  });

  afterEach(async () => {
    await deleteTestUser(testUser);
  });

  it('structural: both unknown-email and wrong-password paths run argon2 exactly once', async () => {
    countingHasher.reset();

    await signIn(
      {
        email: `never-${Date.now()}-a@swecham.test`,
        password: 'whatever',
        portal: 'staff',
        sourceIp: '203.0.113.50',
        requestId: `enum-structural-unknown-${Date.now()}`,
      },
      deps,
    );
    expect(countingHasher.verifyDummyCalls).toBe(1);
    expect(countingHasher.verifyCalls).toBe(0);

    countingHasher.reset();

    await signIn(
      {
        email: testUser.rawEmail,
        password: 'definitely-not-the-password',
        portal: 'staff',
        sourceIp: '203.0.113.50',
        requestId: `enum-structural-wrong-${Date.now()}`,
      },
      deps,
    );
    expect(countingHasher.verifyCalls).toBe(1);
    expect(countingHasher.verifyDummyCalls).toBe(0);
  });

  it(
    `timing: unknown-email and wrong-password medians stay within ${MAX_MEDIAN_RATIO}x of each other`,
    async () => {
      // Warmup — discard the first few samples to let argon2 / JIT /
      // DB connection pool reach steady state.
      for (let i = 0; i < WARMUP_SAMPLES; i += 1) {
        await signIn(
          {
            email: `warmup-${Date.now()}-${i}@swecham.test`,
            password: 'whatever',
            portal: 'staff',
            sourceIp: '203.0.113.51',
            requestId: `enum-warmup-${i}-${Date.now()}`,
          },
          deps,
        );
      }

      const unknownTimes: number[] = [];
      const wrongPwTimes: number[] = [];

      // Interleave so that transient latency spikes affect both sides
      // equally instead of clustering on one.
      for (let i = 0; i < SAMPLES_PER_SIDE; i += 1) {
        const startA = performance.now();
        await signIn(
          {
            email: `never-${Date.now()}-${i}@swecham.test`,
            password: 'whatever',
            portal: 'staff',
            sourceIp: '203.0.113.52',
            requestId: `enum-unknown-${i}-${Date.now()}`,
          },
          deps,
        );
        unknownTimes.push(performance.now() - startA);

        const startB = performance.now();
        await signIn(
          {
            email: testUser.rawEmail,
            password: 'definitely-wrong',
            portal: 'staff',
            sourceIp: '203.0.113.52',
            requestId: `enum-wrong-${i}-${Date.now()}`,
          },
          deps,
        );
        wrongPwTimes.push(performance.now() - startB);
      }

      unknownTimes.sort((a, b) => a - b);
      wrongPwTimes.sort((a, b) => a - b);

      const unknownMedian = median(unknownTimes);
      const wrongMedian = median(wrongPwTimes);
      const unknownP95 = percentile(unknownTimes, 0.95);
      const wrongP95 = percentile(wrongPwTimes, 0.95);
      const p95Delta = Math.abs(unknownP95 - wrongP95);
      const medianRatio =
        Math.max(unknownMedian, wrongMedian) / Math.min(unknownMedian, wrongMedian);

      // Log detailed stats for manual inspection / regression tracking.
      // These numbers are ADVISORY — the assertion below is the
      // regression check.
      console.log(
        `  enumeration-timing: n=${SAMPLES_PER_SIDE} per side, ` +
          `unknown median=${unknownMedian.toFixed(1)}ms p95=${unknownP95.toFixed(1)}ms, ` +
          `wrong-pw median=${wrongMedian.toFixed(1)}ms p95=${wrongP95.toFixed(1)}ms, ` +
          `median ratio=${medianRatio.toFixed(2)}x, ` +
          `|p95 delta|=${p95Delta.toFixed(1)}ms`,
      );

      // The real regression check: neither path is dramatically
      // faster than the other. A ratio > 2 would mean one path is
      // skipping argon2 entirely (or some other large expense) and
      // a timing enumeration attack becomes feasible. The structural
      // test above proves argon2 IS called once on each path; this
      // assertion catches any new shortcut that would invalidate that.
      expect(medianRatio).toBeLessThanOrEqual(MAX_MEDIAN_RATIO);
    },
    { timeout: 120_000 },
  );
});
