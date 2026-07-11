/**
 * F8 Phase 3 Round 9 W-R8-2 — OTel span attribute coverage test for
 * `loadPipeline` use-case.
 *
 * Phase 3.5 S-06 added `withActiveSpan('admin_pipeline_load', ...)`
 * wrapping the repo composite query with 8 attributes:
 *   - 4 upfront: tenant.id, tier_filter, urgency_filter, page_limit
 *   - 4 post-repo: total_in_window_bucket (Round 9 W-R8-4),
 *                  lapsed_count_bucket  (Round 9 W-R8-4),
 *                  page_size,
 *                  month_filter         (T4 telemetry-lens fix)
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
const setStatusMock = vi.fn();
const recordExceptionMock = vi.fn();
const fakeSpan = {
  setAttribute: setAttributeMock,
  setStatus: setStatusMock,
  recordException: recordExceptionMock,
  end: vi.fn(),
  isRecording: () => true,
  spanContext: () => ({ traceId: 't', spanId: 's', traceFlags: 0 }),
} as unknown as Span;

// Round 10 I3 — fakeTracer.startActiveSpan now applies the
// `opts.attributes` map to the span via setAttribute calls before
// invoking fn. Without this, the test only verified the 3 post-repo
// setAttribute calls and the 4 upfront attrs ('tenant.id', tier_filter,
// urgency_filter, page_limit) would be undetectable if dropped.
const fakeTracer = {
  startActiveSpan: (
    _name: string,
    opts: { attributes?: Record<string, unknown> },
    fn: (s: Span) => unknown,
  ): unknown => {
    if (opts?.attributes) {
      for (const [key, value] of Object.entries(opts.attributes)) {
        setAttributeMock(key, value);
      }
    }
    return fn(fakeSpan);
  },
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
    setStatusMock.mockClear();
    recordExceptionMock.mockClear();
  });

  it('sets all 8 attributes on the span (4 upfront + 4 post-repo)', async () => {
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
    // Round 10 I3 — fakeTracer now applies opts.attributes via
    // setAttribute, so all 8 attributes are visible to the mock:
    // 4 upfront (tenant.id, tier_filter, urgency_filter, page_limit)
    // + 4 post-repo (total_in_window_bucket, lapsed_count_bucket,
    // page_size, month_filter).
    expect(setAttributeMock).toHaveBeenCalledTimes(8);
    // 4 upfront attrs.
    expect(setAttributeMock).toHaveBeenCalledWith('tenant.id', 'tenantA');
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.tier_filter',
      'premium',
    );
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.urgency_filter',
      't-30',
    );
    expect(setAttributeMock).toHaveBeenCalledWith('renewals.page_limit', 50);
    // 4 post-repo attrs.
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.total_in_window_bucket',
      expect.any(String),
    );
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.lapsed_count_bucket',
      expect.any(String),
    );
    expect(setAttributeMock).toHaveBeenCalledWith('renewals.page_size', 0);
    // T4 telemetry-lens fix — no month lens here (nowIso undefined →
    // monthFilter null → `monthFilter ?? 'none'` yields 'none').
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.month_filter',
      'none',
    );
  });

  // Round 10 I4 — error-path coverage. If the repo throws, the span
  // MUST receive setStatus(ERROR) + recordException via withActiveSpan,
  // and the throw MUST propagate to the use-case caller.
  it('on repo throw: span receives setStatus(ERROR) + recordException + throw propagates', async () => {
    const repoError = new Error('db: connection lost');
    const deps = {
      tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
      cyclesRepo: {
        loadPipelinePage: vi.fn(async () => {
          throw repoError;
        }),
      } as unknown as RenewalsDeps['cyclesRepo'],
    } as unknown as RenewalsDeps;
    await expect(loadPipeline(deps, baseInput)).rejects.toThrow(
      /connection lost/,
    );
    expect(setStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: SpanStatusCode.ERROR,
        message: expect.stringContaining('connection lost'),
      }),
    );
    expect(recordExceptionMock).toHaveBeenCalledWith(repoError);
  });

  // Round 10 S1 — bucketCount NaN/negative guard. If summary aggregation
  // returns a corrupt count (Drizzle GROUP BY edge case), the span
  // attribute MUST surface as 'invalid' (distinct alarm signal) rather
  // than silently misclassify as '1001+' (fake enterprise-tier).
  it('NaN totalInWindow surfaces as `invalid` bucket (S1 defensive guard)', async () => {
    const deps = fakeDeps({
      rows: [],
      nextCursor: null,
      summary: { totalInWindow: Number.NaN, lapsedCount: 0, byUrgency: {} },
    });
    await loadPipeline(deps, baseInput);
    expect(setAttributeMock).toHaveBeenCalledWith(
      'renewals.total_in_window_bucket',
      'invalid',
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
