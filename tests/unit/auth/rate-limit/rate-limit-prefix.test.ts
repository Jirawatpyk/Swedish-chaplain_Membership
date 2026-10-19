/**
 * The Upstash rate-limit key prefix (PR #586 review M2).
 *
 * It was the constant `swecham`, and the e2e personas' emails are constant,
 * so concurrent CI runs (a PR run and two nightly shards) shared one CI Upstash
 * store and each other's sign-in buckets: one run's lockout or bucket wipe
 * leaked into the next. `RATE_LIMIT_KEY_PREFIX` makes it per run in CI; unset,
 * it stays `swecham`, so production keys do not move.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  rateLimitKeyPattern,
  rateLimitPrefix,
} from '@/modules/auth/infrastructure/rate-limit/rate-limit-prefix';

describe('rateLimitPrefix', () => {
  it('defaults to swecham when unset or empty, so production keys do not move', () => {
    expect(rateLimitPrefix(undefined)).toBe('swecham');
    expect(rateLimitPrefix('')).toBe('swecham');
  });

  it('takes a per-run value', () => {
    expect(rateLimitPrefix('swecham-ci-39102932905-1')).toBe('swecham-ci-39102932905-1');
  });

  it('refuses a value that could widen a key pattern or break a key', () => {
    for (const bad of ['swecham*', 'a b', 'x:y', 'a'.repeat(65), 'UPPER']) {
      expect(() => rateLimitPrefix(bad)).toThrow(/RATE_LIMIT_KEY_PREFIX/);
    }
  });

  it('matches only its own keys when clearing (no other run’s prefix)', () => {
    expect(rateLimitKeyPattern('swecham-ci-1-1')).toBe('swecham-ci-1-1:*');
    expect(rateLimitKeyPattern('swecham')).toBe('swecham:*');
  });
});

describe('UpstashRateLimiter uses the configured prefix', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock('@upstash/ratelimit');
    vi.doUnmock('@upstash/redis');
  });

  it('passes RATE_LIMIT_KEY_PREFIX to Ratelimit', async () => {
    const prefixes: string[] = [];
    vi.doMock('@upstash/ratelimit', () => {
      class MockRatelimit {
        static slidingWindow() {
          return 'sliding-window-stub';
        }
        constructor(options: { prefix: string }) {
          prefixes.push(options.prefix);
        }
        async limit() {
          return { success: true, remaining: 4, reset: Date.now() + 1000 };
        }
      }
      return { Ratelimit: MockRatelimit };
    });
    vi.doMock('@upstash/redis', () => ({ Redis: class {} }));
    vi.stubEnv('RATE_LIMIT_KEY_PREFIX', 'swecham-ci-7-1');
    const { rateLimiter } = await import('@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter');
    await rateLimiter.check(`prefix-test-${Math.random()}`, 5, 60);
    expect(prefixes).toEqual(['swecham-ci-7-1']);
  });
});
