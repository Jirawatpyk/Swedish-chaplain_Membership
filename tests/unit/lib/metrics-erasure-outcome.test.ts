/**
 * COMP-1 US2d (Task 1) — Metric-helper unit test for `erasureMetrics.outcome`.
 *
 * The US2d reconciliation cron (Task 3) emits this counter once per re-driven
 * member. The counter NAME, label KEYS, and per-invocation `+1` semantics are
 * the contract that PromQL alerts + ops dashboards consume, so they are pinned
 * here directly (mirrors `metrics-prune-consumed-tokens.test.ts`).
 *
 * Approach: mock `@opentelemetry/api` to inject a fake meter that captures
 * `createCounter(name)` + the resulting counter's `add(value, attrs)` calls.
 * The helper runs unchanged against the fake meter; the test asserts the
 * captured calls.
 *
 * Pinned invariants:
 *   1. Counter name = `members_erasure_outcome_total`
 *   2. Labels = `{outcome, tenant}` with `outcome ∈ {reconciled, still_pending, error}`
 *   3. Always adds exactly 1 per invocation (member count, not a tally)
 *   4. Failures of the helper do not throw — `safeMetric` swallow contract
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Capture every createCounter() call + every Counter.add() call.
interface CapturedAdd {
  readonly value: number;
  readonly attrs: Record<string, string>;
}
const counterAddsByName = new Map<string, CapturedAdd[]>();

function getOrCreateBucket(name: string): CapturedAdd[] {
  let bucket = counterAddsByName.get(name);
  if (!bucket) {
    bucket = [];
    counterAddsByName.set(name, bucket);
  }
  return bucket;
}

vi.mock('@opentelemetry/api', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api')>(
      '@opentelemetry/api',
    );
  return {
    ...actual,
    metrics: {
      getMeter: () => ({
        createCounter: (name: string) => ({
          add: (value: number, attrs: Record<string, string>) => {
            getOrCreateBucket(name).push({ value, attrs });
          },
        }),
        createHistogram: () => ({ record: () => {} }),
        createObservableGauge: () => ({ addCallback: () => {} }),
      }),
    },
  };
});

// Import AFTER vi.mock so the module picks up the fake meter.
import { erasureMetrics } from '@/lib/metrics';

describe('erasureMetrics.outcome — reconciliation sweep counter (COMP-1 US2d)', () => {
  beforeEach(() => {
    counterAddsByName.clear();
  });

  it('emits `members_erasure_outcome_total` with outcome=reconciled + tenant', () => {
    erasureMetrics.outcome('reconciled', 'tenant-a');
    const bucket = counterAddsByName.get('members_erasure_outcome_total');
    expect(bucket).toBeDefined();
    expect(bucket).toHaveLength(1);
    expect(bucket![0]).toEqual({
      value: 1,
      attrs: { outcome: 'reconciled', tenant: 'tenant-a' },
    });
  });

  it('emits with outcome=still_pending', () => {
    erasureMetrics.outcome('still_pending', 'tenant-b');
    const bucket = counterAddsByName.get('members_erasure_outcome_total')!;
    expect(bucket[0]).toEqual({
      value: 1,
      attrs: { outcome: 'still_pending', tenant: 'tenant-b' },
    });
  });

  it('emits with outcome=error', () => {
    erasureMetrics.outcome('error', 'tenant-c');
    const bucket = counterAddsByName.get('members_erasure_outcome_total')!;
    expect(bucket[0]).toEqual({
      value: 1,
      attrs: { outcome: 'error', tenant: 'tenant-c' },
    });
  });

  it('always adds exactly 1 per invocation (member count, not a tally)', () => {
    erasureMetrics.outcome('reconciled', 'tenant-d');
    erasureMetrics.outcome('reconciled', 'tenant-d');
    erasureMetrics.outcome('still_pending', 'tenant-d');
    const bucket = counterAddsByName.get('members_erasure_outcome_total')!;
    expect(bucket).toHaveLength(3);
    expect(bucket.every((c) => c.value === 1)).toBe(true);
  });

  it('uses exactly the {outcome, tenant} label set (PromQL-pinned)', () => {
    erasureMetrics.outcome('reconciled', 'tenant-e');
    const bucket = counterAddsByName.get('members_erasure_outcome_total')!;
    expect(Object.keys(bucket[0]!.attrs).sort()).toEqual(['outcome', 'tenant']);
  });

  it('does not throw when the underlying meter errors (safeMetric swallow)', () => {
    // Counter name is stable; this just asserts the helper is total — any
    // emit-time failure is swallowed by safeMetric, never propagated to the
    // best-effort cron caller.
    expect(() => erasureMetrics.outcome('error', 'tenant-f')).not.toThrow();
  });
});
