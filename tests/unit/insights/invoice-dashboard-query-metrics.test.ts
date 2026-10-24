/**
 * 124 invoice dashboard — every dashboard query records its duration on
 * `insights_invoice_dashboard_query_duration_ms` (labels `card`, `outcome`),
 * on BOTH outcomes: a query that works then throws still lands a sample, so
 * the p95 cannot stay green through an outage (the timeline precedent,
 * `drizzle-timeline-repo.ts`). The error itself still reaches the loader.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryDuration = vi.fn();
vi.mock('@/lib/metrics', () => ({
  insightsMetrics: { invoiceDashboardQueryDurationMs: (...a: unknown[]) => queryDuration(...a) },
}));

let failWith: Error | null = null;
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: vi.fn(async () => {
        if (failWith) throw failWith;
        return [{ amount: '0', n: 0, billed: '0', collected: '0', month: '2026-01' }];
      }),
    }),
  ),
}));

const { invoiceDashboardSourceAdapter: adapter } = await import(
  '@/modules/insights/infrastructure/sources/invoice-dashboard-source-adapter'
);

const CTX = { slug: 'tenant-metrics' } as never;
const FILTERS = { type: 'all', fiscalYear: 2026, planId: null, origin: 'all' } as const;
const RANGE = { from: '2026-01-01', to: '2026-06-15' };

const CALLS = [
  ['aging', () => adapter.outstandingByAgingBucket(CTX, FILTERS, '2026-06-15')],
  ['collected', () => adapter.collectedInRange(CTX, FILTERS, RANGE)],
  ['methods', () => adapter.collectedByMethod(CTX, FILTERS, RANGE)],
  ['trend', () => adapter.monthlyBilledCollected(CTX, FILTERS, RANGE, RANGE)],
  ['attention', () => adapter.attentionCounts(CTX, FILTERS, new Date('2026-06-15T05:00:00Z'))],
  ['oldest_overdue', () => adapter.oldestOverdue(CTX, FILTERS, '2026-06-15', 6)],
  ['any_invoice', () => adapter.hasNonDraftInvoice(CTX)],
  ['drafts', () => adapter.draftCount(CTX, FILTERS)],
] as const;

beforeEach(() => {
  queryDuration.mockReset();
  failWith = null;
});

describe('insights_invoice_dashboard_query_duration_ms', () => {
  for (const [card, run] of CALLS) {
    it(`${card}: one sample with outcome ok`, async () => {
      await run();
      expect(queryDuration).toHaveBeenCalledTimes(1);
      const [ms, label, outcome] = queryDuration.mock.calls[0] as [number, string, string];
      expect(label).toBe(card);
      expect(outcome).toBe('ok');
      expect(ms).toBeGreaterThanOrEqual(0);
    });

    it(`${card}: a failing query still records, with outcome error, and the error propagates`, async () => {
      failWith = new TypeError('connection reset');
      await expect(run()).rejects.toThrow('connection reset');
      expect(queryDuration).toHaveBeenCalledTimes(1);
      expect(queryDuration.mock.calls[0]?.slice(1)).toEqual([card, 'error']);
    });
  }
});
