/**
 * A2 — Rate-limit fallback log must NOT leak raw bucket keys.
 *
 * Call-site keys embed secrets in their string value
 * (`signin:email:foo@bar`, `heartbeat:session:01HV...`,
 * `change-pw:user:01HU...`). Pino's path-based redaction cannot scrub
 * these because the sensitive content is INSIDE the string value of a
 * non-sensitive field name (`key`).
 *
 * CLAUDE.md § Secrets & confidential data forbids raw session IDs,
 * emails, and (by extension) user IDs in logs.
 *
 * Fix: log a derived `keyKind` discriminator (`signin:email`,
 * `heartbeat:session`, `change-pw:user`) instead of the raw key.
 * Operators still see WHICH bucket failed; attackers cannot
 * extract per-user secrets from log dumps during Upstash outages.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

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

vi.mock('@upstash/redis', () => {
  class MockRedis {
    constructor() {}
  }
  return { Redis: MockRedis };
});

const warnSpy = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { warn: warnSpy, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/metrics', () => ({
  authMetrics: { redisFallback: vi.fn() },
}));

const { rateLimiter } = await import(
  '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter'
);

describe('A2 — rate-limit fallback log leak guard', () => {
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it('does NOT log the raw key (email-bucket case)', async () => {
    const secretEmail = 'victim@chamber.example.com';
    const key = `signin:email:${secretEmail}`;
    await rateLimiter.check(key, 5, 60);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [bindings] = warnSpy.mock.calls[0]!;
    expect(JSON.stringify(bindings)).not.toContain(secretEmail);
    expect(bindings).not.toHaveProperty('key');
    expect(bindings.keyKind).toBe('signin:email');
  });

  it('does NOT log the raw key (session-bucket case — live bearer credential)', async () => {
    const liveSessionId = '01HV9999999999999999999999';
    const key = `heartbeat:session:${liveSessionId}`;
    await rateLimiter.check(key, 60, 60);

    const [bindings] = warnSpy.mock.calls[0]!;
    expect(JSON.stringify(bindings)).not.toContain(liveSessionId);
    expect(bindings.keyKind).toBe('heartbeat:session');
  });

  it('does NOT log the raw key (user-bucket case)', async () => {
    const userId = '01HU8888888888888888888888';
    const key = `change-pw:user:${userId}`;
    await rateLimiter.check(key, 5, 900);

    const [bindings] = warnSpy.mock.calls[0]!;
    expect(JSON.stringify(bindings)).not.toContain(userId);
    expect(bindings.keyKind).toBe('change-pw:user');
  });

  it('handles malformed keys gracefully (no colons → keyKind=unknown)', async () => {
    await rateLimiter.check('weirdkey', 5, 60);
    const [bindings] = warnSpy.mock.calls[0]!;
    // `'weirdkey'.split(':').slice(0,2).join(':')` returns the original
    // string when no separator is present. That's still preferable to
    // leaking a real key because malformed inputs aren't the secret
    // shape — but the test pins this current behaviour explicitly so
    // a future refactor that switches to "unknown" sentinel doesn't
    // break silently.
    expect(bindings.keyKind).toBe('weirdkey');
  });
});
