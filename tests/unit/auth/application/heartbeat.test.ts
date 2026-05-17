/**
 * `heartbeat` use case unit test (spec FR-022, Constitution
 * Principle II 80% branch coverage mandate).
 *
 * Two reachable branches:
 *   1. Rate-limit exhausted → err('rate-limited') with retryAfter
 *   2. Success → updateLastSeen called, ok({ lastSeenAt })
 *
 * Deps (SessionRepo + RateLimiter) are stubbed — this is a pure
 * Application-layer test with no DB or Upstash touch.
 */
import { describe, expect, it, vi } from 'vitest';
import { heartbeat } from '@/modules/auth/application/heartbeat';
import { asSessionId } from '@/modules/auth/domain/branded';

describe('heartbeat use case', () => {
  const TEST_SESSION_ID = asSessionId('a'.repeat(64));
  const NOW = new Date('2026-04-10T12:00:00Z');

  function makeStubs(opts: {
    rateLimitOk: boolean;
    resetMs?: number;
  }) {
    const updateLastSeen = vi.fn(async () => undefined);
    const check = vi.fn(async () => ({
      success: opts.rateLimitOk,
      limit: 60,
      remaining: opts.rateLimitOk ? 59 : 0,
      reset: opts.resetMs ?? Date.now() + 30_000,
      fellBack: false,
    }));
    return {
      sessions: {
        // Only updateLastSeen is called by the use case — other methods
        // (incl. *InTx variants added in A3/A4) are stubs.
        create: vi.fn(),
        createInTx: vi.fn(),
        findById: vi.fn(),
        updateLastSeen,
        delete: vi.fn(),
        deleteByUserId: vi.fn(),
        deleteByUserIdInTx: vi.fn(),
        deleteByUserIdExcept: vi.fn(),
      },
      limiter: {
        check,
        // B2 — peek added to RateLimiter port; heartbeat doesn't use it
        // but the type-check still requires the method.
        peek: vi.fn(async () => ({
          success: true,
          limit: 60,
          remaining: 60,
          reset: Date.now() + 60_000,
          fellBack: false,
        })),
      },
      now: () => NOW,
      _updateLastSeen: updateLastSeen,
      _check: check,
    };
  }

  it('success path: updates last-seen and returns ok({ lastSeenAt })', async () => {
    const stubs = makeStubs({ rateLimitOk: true });

    const result = await heartbeat(
      { sessionId: TEST_SESSION_ID, requestId: 'req-1' },
      stubs,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lastSeenAt).toEqual(NOW);
    // updateLastSeen called exactly once with the test session id + NOW
    expect(stubs._updateLastSeen).toHaveBeenCalledTimes(1);
    expect(stubs._updateLastSeen).toHaveBeenCalledWith(TEST_SESSION_ID, NOW);
    // Rate-limit key is namespaced on the SHA-256 of the session id
    // (F1 Round 2 C1 — was plaintext, switched to hash to prevent the
    // plaintext bearer leaking into Upstash Redis).
    const { sha256Hex } = await import('@/lib/crypto');
    expect(stubs._check).toHaveBeenCalledWith(
      `heartbeat:session:${sha256Hex(TEST_SESSION_ID)}`,
      60,
      60,
    );
  });

  it('rate-limited: returns err with retryAfterSeconds, does NOT update last-seen', async () => {
    // Reset 45 seconds in the future
    const resetMs = Date.now() + 45_000;
    const stubs = makeStubs({ rateLimitOk: false, resetMs });

    const result = await heartbeat(
      { sessionId: TEST_SESSION_ID, requestId: 'req-2' },
      stubs,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('rate-limited');
    expect(result.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.error.retryAfterSeconds).toBeLessThanOrEqual(60);
    // Critical: side effect MUST NOT happen on the rate-limited path
    expect(stubs._updateLastSeen).not.toHaveBeenCalled();
  });

  it('rate-limited: retryAfterSeconds is at least 1 even if reset is in the past', async () => {
    // Clock skew edge case: `rl.reset` is in the past (Upstash clock
    // drift). retryAfter should floor at 1 second, not 0 or negative.
    const stubs = makeStubs({ rateLimitOk: false, resetMs: Date.now() - 1000 });

    const result = await heartbeat(
      { sessionId: TEST_SESSION_ID, requestId: 'req-3' },
      stubs,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});
