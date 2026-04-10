/**
 * B-02 — Upstash fail-open test (security.md § 5 item 12).
 *
 * The rate limiter (`upstash-rate-limiter.ts`) MUST fall back to an
 * in-memory bucket when Upstash is unreachable. This is the
 * Constitution Principle VIII (Reliability) trade-off: a small abuse
 * risk during an Upstash outage is preferable to a total auth outage.
 *
 * The fallback path is implemented inside `UpstashRateLimiter.check`
 * (try / catch around `Ratelimit.limit()`), but until this test was
 * added it had ZERO test coverage — `dos-rate-limit.test.ts` exercises
 * the live Upstash happy path only. The § 5 review-gate checklist
 * explicitly requires "Rate limiter fail-open behaviour is tested
 * with Upstash unreachable".
 *
 * Strategy:
 *   - vi.mock(@upstash/ratelimit) to inject a Ratelimit class whose
 *     `.limit()` throws — simulating "Upstash unavailable".
 *   - Import `rateLimiter` AFTER the mock is set up so the singleton
 *     binds to the mocked module.
 *   - Assert: (a) the call returns success rather than re-throwing,
 *     (b) the in-memory fallback enforces the same `max` budget,
 *     (c) `authMetrics.redisFallback()` is called per fallback hit.
 *
 * NOTE: this test imports the LIVE `upstash-rate-limiter` module,
 * which side-effects-creates a `Redis` client at module load. The
 * Redis client constructor only validates the URL/token shape — no
 * actual network call happens — so this is safe in CI without
 * Upstash creds (env vars are still required because `env.ts` parses
 * them at boot; tests inherit the test fixture env via vitest.config).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock @upstash/ratelimit BEFORE importing the limiter so the module
// graph picks up the mocked Ratelimit class.
vi.mock('@upstash/ratelimit', () => {
  class MockRatelimit {
    static slidingWindow() {
      return 'sliding-window-stub';
    }
    async limit() {
      throw new Error('upstash unavailable: simulated outage');
    }
  }
  return { Ratelimit: MockRatelimit };
});

// Mock @upstash/redis so the side-effect Redis() constructor doesn't
// try to validate or talk to a real endpoint.
vi.mock('@upstash/redis', () => {
  class MockRedis {
    constructor() {}
  }
  return { Redis: MockRedis };
});

// Track redisFallback metric calls.
const redisFallbackSpy = vi.fn();
vi.mock('@/lib/metrics', () => ({
  authMetrics: {
    redisFallback: redisFallbackSpy,
  },
}));

// Import AFTER mocks are registered.
const { rateLimiter } = await import(
  '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter'
);

describe('UpstashRateLimiter fail-open behaviour (B-02, security § 5 item 12)', () => {
  beforeEach(() => {
    redisFallbackSpy.mockClear();
  });

  afterEach(() => {
    // Reset the in-memory fallback bucket between tests by waiting for
    // the window to slide. The fallback uses a per-test unique key to
    // avoid cross-test pollution instead — see test bodies.
  });

  it('falls back to in-memory bucket when Upstash throws + records the metric', async () => {
    const key = `b02-fallback-success-${Date.now()}-${Math.random()}`;
    const result = await rateLimiter.check(key, 5, 60);

    // (a) The call returns a successful result, NOT throws — the
    // Application layer never sees the Upstash error.
    expect(result.success).toBe(true);
    expect(result.remaining).toBe(4);
    expect(typeof result.reset).toBe('number');

    // (b) The fallback metric was incremented exactly once.
    expect(redisFallbackSpy).toHaveBeenCalledTimes(1);
  });

  it('in-memory fallback enforces the configured max budget', async () => {
    // Use a unique key so this test does not interact with sibling
    // tests' in-memory state.
    const key = `b02-fallback-cap-${Date.now()}-${Math.random()}`;
    const max = 3;
    const window = 60;

    // Three calls within the window should all succeed.
    for (let i = 0; i < max; i += 1) {
      const r = await rateLimiter.check(key, max, window);
      expect(r.success).toBe(true);
      expect(r.remaining).toBe(max - 1 - i);
    }

    // Fourth call MUST be rejected — the in-memory cap is enforced
    // even when Upstash is unreachable. This is the security
    // assertion: a fail-open limiter with no cap would let an
    // attacker DoS the auth surface during an Upstash outage.
    const denied = await rateLimiter.check(key, max, window);
    expect(denied.success).toBe(false);
    expect(denied.remaining).toBe(0);

    // Each call hit the fallback path → metric was incremented for
    // each one (total 4 across this test, not counting the previous
    // test's call).
    expect(redisFallbackSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('different keys have independent fallback buckets', async () => {
    const keyA = `b02-independent-A-${Date.now()}-${Math.random()}`;
    const keyB = `b02-independent-B-${Date.now()}-${Math.random()}`;

    // Exhaust bucket A.
    for (let i = 0; i < 2; i += 1) {
      await rateLimiter.check(keyA, 2, 60);
    }
    const aDenied = await rateLimiter.check(keyA, 2, 60);
    expect(aDenied.success).toBe(false);

    // Bucket B is still fresh.
    const bFirst = await rateLimiter.check(keyB, 2, 60);
    expect(bFirst.success).toBe(true);
    expect(bFirst.remaining).toBe(1);
  });
});
