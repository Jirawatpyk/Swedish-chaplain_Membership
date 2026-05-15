/**
 * R3 — `createEventRateLimitFallback` metric emit coverage.
 *
 * `createEventRateLimitCheck` (composition adapter at
 * `src/lib/events-create-deps.ts`) emits this counter when the
 * Upstash rate-limit primitive falls open (process-local bucket
 * substitute). Without this test, deleting the metric emit would
 * leave the SRE fail-open alert silently uncovered.
 *
 * Lives in its own file so it can `vi.mock` the rate-limit primitive
 * + the metrics module without colliding with the route-handler
 * contract test's top-level mocks for `@/lib/events-create-deps`.
 */
import { describe, expect, it, vi } from 'vitest';

const rateLimiterCheckMock = vi.fn();
const createEventRateLimitFallbackMock = vi.fn();

vi.mock(
  '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter',
  () => ({
    rateLimiter: { check: rateLimiterCheckMock },
  }),
);

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/metrics', () => ({
  eventcreateMetrics: {
    createEventRateLimitFallback: createEventRateLimitFallbackMock,
    createEventDurationSeconds: vi.fn(),
  },
  safeMetric: vi.fn((fn: () => void) => fn()),
}));

describe('createEventRateLimitCheck — fail-open metric', () => {
  it('emits createEventRateLimitFallback once with tenant slug when Upstash falls back', async () => {
    rateLimiterCheckMock.mockResolvedValue({
      success: true,
      fellBack: true,
      reset: Date.now() + 3_600_000,
    });
    createEventRateLimitFallbackMock.mockClear();

    const { createEventRateLimitCheck } = await import(
      '@/lib/events-create-deps'
    );

    const result = await createEventRateLimitCheck(
      'test-chamber',
      '00000000-0000-0000-0000-000000000abc',
    );

    expect(result.success).toBe(true);
    expect(createEventRateLimitFallbackMock).toHaveBeenCalledTimes(1);
    expect(createEventRateLimitFallbackMock).toHaveBeenCalledWith(
      'test-chamber',
    );
  });

  it('does NOT emit createEventRateLimitFallback on healthy Upstash path', async () => {
    rateLimiterCheckMock.mockResolvedValue({
      success: true,
      fellBack: false,
      reset: Date.now() + 3_600_000,
    });
    createEventRateLimitFallbackMock.mockClear();

    const { createEventRateLimitCheck } = await import(
      '@/lib/events-create-deps'
    );

    const result = await createEventRateLimitCheck(
      'test-chamber',
      '00000000-0000-0000-0000-000000000abc',
    );

    expect(result.success).toBe(true);
    expect(createEventRateLimitFallbackMock).not.toHaveBeenCalled();
  });

  it('does NOT emit createEventRateLimitFallback on healthy rate-limit-hit (success=false)', async () => {
    rateLimiterCheckMock.mockResolvedValue({
      success: false,
      fellBack: false,
      reset: Date.now() + 3_600_000,
    });
    createEventRateLimitFallbackMock.mockClear();

    const { createEventRateLimitCheck } = await import(
      '@/lib/events-create-deps'
    );

    const result = await createEventRateLimitCheck(
      'test-chamber',
      '00000000-0000-0000-0000-000000000abc',
    );

    expect(result.success).toBe(false);
    expect(createEventRateLimitFallbackMock).not.toHaveBeenCalled();
  });
});
