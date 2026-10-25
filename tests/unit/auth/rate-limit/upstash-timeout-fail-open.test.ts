/**
 * 128 — a SLOW Upstash must not switch rate limiting off.
 *
 * `@upstash/ratelimit` races every `.limit()` against a 5 s timeout and, when
 * the timeout wins, RESOLVES `{ success: true, reason: 'timeout' }` instead of
 * throwing. `UpstashRateLimiter.check` only fell back to the in-memory bucket
 * on a throw, so during an Upstash latency spike every limiter (sign-in,
 * reset-password, portal invite …) allowed every request — and reported
 * `fellBack: false`. Found when `invite-colleague-route-enumeration` let the
 * 11th invite through on a slow dev Upstash (2026-10-25).
 *
 * A timed-out result is now treated exactly like an unreachable Upstash: the
 * in-memory bucket decides, and the fallback metric is recorded.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ctorOpts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@upstash/ratelimit', () => {
  class MockRatelimit {
    constructor(opts: Record<string, unknown>) {
      ctorOpts.push(opts);
    }
    static slidingWindow() {
      return 'sliding-window-stub';
    }
    async limit() {
      // The library's own timeout branch (dist/index.js applyTimeout).
      return {
        success: true,
        limit: 0,
        remaining: 0,
        reset: 0,
        pending: Promise.resolve(),
        reason: 'timeout',
      };
    }
  }
  return { Ratelimit: MockRatelimit };
});

vi.mock('@upstash/redis', () => {
  class MockRedis {
    constructor() {}
  }
  return { Redis: MockRedis };
});

const redisFallbackSpy = vi.fn();
vi.mock('@/lib/metrics', () => ({
  authMetrics: { redisFallback: redisFallbackSpy },
}));

const warnSpy = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { rateLimiter } = await import(
  '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter'
);

describe('UpstashRateLimiter — a timed-out Upstash call uses the in-memory bucket (128)', () => {
  beforeEach(() => redisFallbackSpy.mockClear());

  it('enforces the budget instead of allowing every request', async () => {
    const key = `t128-${Date.now()}-${Math.random()}`;
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await rateLimiter.check(key, 3, 60));

    expect(results.slice(0, 3).every((r) => r.success)).toBe(true);
    expect(results[3]!.success).toBe(false);
  });

  it('reports fellBack and records the fallback metric', async () => {
    const r = await rateLimiter.check(`t128b-${Date.now()}-${Math.random()}`, 3, 60);
    expect(r.fellBack).toBe(true);
    expect(redisFallbackSpy).toHaveBeenCalledTimes(1);
  });

  it('bounds the wait: the Upstash call times out after 1 s, not the 5 s library default', async () => {
    await rateLimiter.check(`t128c-${Date.now()}-${Math.random()}`, 3, 61);
    expect(ctorOpts.at(-1)?.timeout).toBe(1000);
  });

  it('logs a timeout as a timeout, not as an unreachable Upstash', async () => {
    warnSpy.mockClear();
    await rateLimiter.check(`t128d-${Date.now()}-${Math.random()}`, 3, 60);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: true, err: 'UpstashTimeoutError' }),
      expect.stringContaining('timed out'),
    );
  });
});
