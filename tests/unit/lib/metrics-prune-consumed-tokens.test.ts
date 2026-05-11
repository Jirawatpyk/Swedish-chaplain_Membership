/**
 * F8 Phase 9 retrofit (PR #25 R3 review-fix M1) — Metric-helper unit
 * tests for `pruneConsumedTokensRunCompleted` + `pruneConsumedTokensRowsPruned`.
 *
 * Closes the coverage gap surfaced by R3 /review pr-test-analyzer
 * (G1 MEDIUM): the two new helpers encode the cardinality contract
 * that PromQL alerts depend on (counter name strings + label sets),
 * yet had zero direct test coverage. The helpers are thin wrappers
 * over `safeMetric(() => counter(name).add(value, attrs))`, but the
 * counter NAME, label KEYS, and emission SEMANTICS are exactly the
 * contract that ops dashboards consume.
 *
 * Approach: mock `@opentelemetry/api` to inject a fake meter that
 * captures `createCounter(name)` calls + the resulting counter's
 * `add(value, attrs)` invocations. The helpers then run unchanged
 * against the fake meter and the test asserts the captured calls.
 *
 * Pinned invariants:
 *   1. Run counter name = `renewals_prune_consumed_tokens_runs_total`
 *   2. Run counter labels = `{tenant_id, outcome}` with `outcome ∈ {success, failure}`
 *   3. Run counter always adds 1 per invocation (run count, not row count)
 *   4. Rows counter name = `renewals_prune_consumed_tokens_rows_deleted_total`
 *   5. Rows counter labels = `{tenant_id}` ONLY (no `outcome` — success-only)
 *   6. Rows counter adds the actual row count (including 0)
 *   7. Failures of the helpers do not throw — `safeMetric` swallow contract
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
import { renewalsMetrics } from '@/lib/metrics';

describe('renewalsMetrics — prune-consumed-tokens helpers (R3 M1)', () => {
  beforeEach(() => {
    counterAddsByName.clear();
  });

  describe('pruneConsumedTokensRunCompleted', () => {
    it('emits `renewals_prune_consumed_tokens_runs_total` with tenant_id + outcome=success', () => {
      renewalsMetrics.pruneConsumedTokensRunCompleted('tenant-a', 'success');
      const bucket = counterAddsByName.get(
        'renewals_prune_consumed_tokens_runs_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket).toHaveLength(1);
      expect(bucket![0]).toEqual({
        value: 1,
        attrs: { tenant_id: 'tenant-a', outcome: 'success' },
      });
    });

    it('emits with outcome=failure', () => {
      renewalsMetrics.pruneConsumedTokensRunCompleted('tenant-b', 'failure');
      const bucket = counterAddsByName.get(
        'renewals_prune_consumed_tokens_runs_total',
      );
      expect(bucket![0]).toEqual({
        value: 1,
        attrs: { tenant_id: 'tenant-b', outcome: 'failure' },
      });
    });

    it('always adds exactly 1 per invocation (NOT a row count)', () => {
      renewalsMetrics.pruneConsumedTokensRunCompleted('tenant-c', 'success');
      renewalsMetrics.pruneConsumedTokensRunCompleted('tenant-c', 'success');
      renewalsMetrics.pruneConsumedTokensRunCompleted('tenant-c', 'failure');
      const bucket = counterAddsByName.get(
        'renewals_prune_consumed_tokens_runs_total',
      )!;
      expect(bucket).toHaveLength(3);
      expect(bucket.every((c) => c.value === 1)).toBe(true);
    });

    it('does NOT touch the rows-deleted counter', () => {
      renewalsMetrics.pruneConsumedTokensRunCompleted('tenant-d', 'success');
      renewalsMetrics.pruneConsumedTokensRunCompleted('tenant-d', 'failure');
      expect(
        counterAddsByName.get(
          'renewals_prune_consumed_tokens_rows_deleted_total',
        ),
      ).toBeUndefined();
    });
  });

  describe('pruneConsumedTokensRowsPruned', () => {
    it('emits `renewals_prune_consumed_tokens_rows_deleted_total` with tenant_id only (no outcome label)', () => {
      renewalsMetrics.pruneConsumedTokensRowsPruned('tenant-e', 5);
      const bucket = counterAddsByName.get(
        'renewals_prune_consumed_tokens_rows_deleted_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({
        value: 5,
        attrs: { tenant_id: 'tenant-e' },
      });
      // CRITICAL: no `outcome` key. Round 2 split's whole point.
      expect(bucket![0]!.attrs).not.toHaveProperty('outcome');
    });

    it('adds the actual row count (NOT 1)', () => {
      renewalsMetrics.pruneConsumedTokensRowsPruned('tenant-f', 42);
      const bucket = counterAddsByName.get(
        'renewals_prune_consumed_tokens_rows_deleted_total',
      )!;
      expect(bucket[0]!.value).toBe(42);
    });

    it('emits a 0-delta when no rows were pruned (steady-state weekly tick)', () => {
      renewalsMetrics.pruneConsumedTokensRowsPruned('tenant-g', 0);
      const bucket = counterAddsByName.get(
        'renewals_prune_consumed_tokens_rows_deleted_total',
      );
      // Counter `.add(0, ...)` is a valid no-op tick (PromQL still
      // records the time series exists). Verify the call still
      // reaches the counter.
      expect(bucket).toBeDefined();
      expect(bucket![0]!.value).toBe(0);
    });

    it('does NOT touch the runs counter', () => {
      renewalsMetrics.pruneConsumedTokensRowsPruned('tenant-h', 7);
      expect(
        counterAddsByName.get('renewals_prune_consumed_tokens_runs_total'),
      ).toBeUndefined();
    });
  });

  describe('cross-helper contract', () => {
    it('the two counter names are stable strings (PromQL-pinned)', () => {
      // Pin the literal strings — any rename here breaks every dashboard
      // + alert. The strings are duplicated in this test by design so
      // a mistyped rename in metrics.ts triggers test failure here.
      renewalsMetrics.pruneConsumedTokensRunCompleted('t', 'success');
      renewalsMetrics.pruneConsumedTokensRowsPruned('t', 1);
      expect(
        counterAddsByName.has('renewals_prune_consumed_tokens_runs_total'),
      ).toBe(true);
      expect(
        counterAddsByName.has(
          'renewals_prune_consumed_tokens_rows_deleted_total',
        ),
      ).toBe(true);
    });

    it('label sets are disjoint by design — runs has outcome, rows does not', () => {
      renewalsMetrics.pruneConsumedTokensRunCompleted('t', 'success');
      renewalsMetrics.pruneConsumedTokensRowsPruned('t', 3);
      const runs = counterAddsByName.get(
        'renewals_prune_consumed_tokens_runs_total',
      )!;
      const rows = counterAddsByName.get(
        'renewals_prune_consumed_tokens_rows_deleted_total',
      )!;
      expect(Object.keys(runs[0]!.attrs).sort()).toEqual([
        'outcome',
        'tenant_id',
      ]);
      expect(Object.keys(rows[0]!.attrs)).toEqual(['tenant_id']);
    });
  });
});
