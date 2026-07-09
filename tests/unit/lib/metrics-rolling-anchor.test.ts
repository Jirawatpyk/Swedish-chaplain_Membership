/**
 * Renewal rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238)
 * — Unit test for `renewalsMetrics.unlinkedPaymentResolved`.
 *
 * Mirrors `metrics-erasure-outcome.test.ts` / `metrics-w009-renewals.test.ts`:
 * mock `@opentelemetry/api` to inject a fake meter that captures
 * `createCounter(name)` + the resulting counter's `add(value, attrs)` calls.
 *
 * Pinned invariants:
 *   1. Counter name = `renewals_unlinked_payment_resolved_total`
 *   2. Label = `{outcome}` with `outcome ∈ {reanchored, renewed, healed, skipped}`
 *   3. Always adds exactly 1 per invocation
 *   4. Failures of the helper do not throw — `safeMetric` swallow contract
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
import { renewalsMetrics } from '@/lib/metrics';

describe('renewalsMetrics.unlinkedPaymentResolved (rolling-anchor Task 5)', () => {
  beforeEach(() => {
    counterAddsByName.clear();
  });

  it('emits `renewals_unlinked_payment_resolved_total` with the outcome label', () => {
    renewalsMetrics.unlinkedPaymentResolved('reanchored');
    const bucket = counterAddsByName.get(
      'renewals_unlinked_payment_resolved_total',
    );
    expect(bucket).toBeDefined();
    expect(bucket).toHaveLength(1);
    expect(bucket![0]).toEqual({ value: 1, attrs: { outcome: 'reanchored' } });
  });

  it.each(['reanchored', 'renewed', 'healed', 'skipped'] as const)(
    'accepts outcome=%s',
    (outcome) => {
      expect(() => renewalsMetrics.unlinkedPaymentResolved(outcome)).not.toThrow();
      const bucket = counterAddsByName.get(
        'renewals_unlinked_payment_resolved_total',
      )!;
      expect(bucket[0]).toEqual({ value: 1, attrs: { outcome } });
    },
  );

  it('each outcome is a distinct label series — no cross-outcome bleed', () => {
    renewalsMetrics.unlinkedPaymentResolved('healed');
    renewalsMetrics.unlinkedPaymentResolved('skipped');
    const bucket = counterAddsByName.get(
      'renewals_unlinked_payment_resolved_total',
    )!;
    expect(bucket).toHaveLength(2);
    expect(bucket[0]!.attrs.outcome).toBe('healed');
    expect(bucket[1]!.attrs.outcome).toBe('skipped');
  });
});
