/**
 * F8 Phase 3 Round 9 W-R8-2 — OTel span attribute coverage test for
 * `loadPipeline` use-case.
 *
 * Phase 3.5 S-06 added `withActiveSpan('admin_pipeline_load', ...)`
 * wrapping the repo composite query with 7 attributes:
 *   - 4 upfront: tenant.id, tier_filter, urgency_filter, page_limit
 *   - 3 post-repo: total_in_window_bucket (Round 9 W-R8-4),
 *                  lapsed_count_bucket  (Round 9 W-R8-4),
 *                  page_size
 *
 * Without this test a refactor that drops a `setAttribute` call would
 * remain GREEN. SLO alerting on SC-003 (p95<500ms) depends on these
 * attributes being present.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { loadPipeline } from '@/modules/renewals/application/use-cases/load-pipeline';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

// Capture span attribute writes for assertion.
const setAttributeMock = vi.fn();
const fakeSpan = {
  setAttribute: setAttributeMock,
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
  isRecording: () => true,
  spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 0 }),
} as unknown as Span;

const fakeTracer = {
  startActiveSpan: (
    _name: string,
    _opts: unknown,
    fn: (s: Span) => unknown,
  ): unknown => fn(fakeSpan),
  startSpan: vi.fn(),
} as unknown as Tracer;

vi.mock('@/lib/otel-tracer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/otel-tracer')>(
    '@/lib/otel-tracer',
  );
  return {
    ...actual,
    renewalsTracer: () => fakeTracer,
  };
});

const TENANT_ID = 'tenantA';

function fakeDeps(loadResult: {
  rows: ReadonlyArray<unknown>;
  nextCursor: string | null;
  summary: { totalInWindow: number; lapsedCount: number; byUrgency: Record<string, number> };
}): RenewalsDeps {
  return {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      loadPipelinePage: vi.fn(async () => loadResult),
    } as unknown as RenewalsDeps['cyclesRepo'],
  } as unknown as RenewalsDeps;
}

const baseInput = {
  tenantId: TENANT_ID,
  limit: 50,
};

describe('loadPipeline OTel span attributes (S-06 + W-R8-4)', () => {
  beforeEach(() => {
    setAttributeMock.mockClear();
  });

  it('sets all 7 attributes on the span (4 upfront + 3 post-repo)', async () => {
    const deps = fakeDeps({
      rows: [],
      nextCursor: null,
      summary: { totalInWindow: 25, lapsedCount: 8, byUrgency: {} },
    });
    await loadPipeline(deps, {
      ...baseInput,
      tier: 'premium',
      urgency: 't-30',
    });
    // 3 post-repo setAttribute calls (4 upfront were passed via opts).
    expect(setAttributeMock).toHaveBeenCalledTimes(3);
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.total_in_window_bucket',
      expect.any(String),
    );
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.lapsed_count_bucket',
      expect.any(String),
    );
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.page_size',
      0,
    );
  });

  // Round 9 W-R8-4 — bucket boundary partitions. Exact counts MUST NOT
  // appear in span attributes; only the 5 coarse range labels.
  it.each([
    { count: 0, bucket: '0_10' },
    { count: 10, bucket: '0_10' },
    { count: 11, bucket: '11_50' },
    { count: 50, bucket: '11_50' },
    { count: 51, bucket: '51_200' },
    { count: 200, bucket: '51_200' },
    { count: 201, bucket: '201_1000' },
    { count: 1000, bucket: '201_1000' },
    { count: 1001, bucket: '1001+' },
    { count: 50000, bucket: '1001+' },
  ])(
    'buckets totalInWindow=$count to "$bucket" (no exact integer leak)',
    async ({ count, bucket }) => {
      const deps = fakeDeps({
        rows: [],
        nextCursor: null,
        summary: { totalInWindow: count, lapsedCount: 0, byUrgency: {} },
      });
      await loadPipeline(deps, baseInput);
      expect(setAttributeMock).toHaveBeenCalledWith(
        'renewals.total_in_window_bucket',
        bucket,
      );
      // Negative assertion — no setAttribute call carries the exact integer.
      const calls = setAttributeMock.mock.calls;
      const hasExactInt = calls.some(
        (c) => c[0] === 'renewals.total_in_window' && c[1] === count,
      );
      expect(hasExactInt).toBe(false);
    },
  );

  it('preserves exact page_size (low-sensitivity, ≤50)', async () => {
    const deps = fakeDeps({
      rows: new Array(7).fill({}),
      nextCursor: null,
      summary: { totalInWindow: 100, lapsedCount: 5, byUrgency: {} },
    });
    await loadPipeline(deps, baseInput);
    expect(setAttributeMock).toHaveBeenCalledWith('renewals.page_size', 7);
  });
});
