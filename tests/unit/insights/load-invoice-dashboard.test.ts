/**
 * 124 slice 2 — the invoice dashboard's per-card loaders, against a stubbed
 * `InvoiceDashboardSource` (the SQL itself is proven on live Neon in
 * `tests/integration/insights/invoice-dashboard-figures.test.ts`).
 *
 * What the loaders own, and these tests pin:
 *   - the dates each card asks for: `today` threaded unchanged; Collected this
 *     month = the calendar month of `today` whatever FY is selected; Collected
 *     in FY and By method = the FY range clamped to `today`; the trend = the
 *     FY's 12 month slots, future months empty (US1.4/1.5, US3.3);
 *   - Outstanding / Overdue derived from the aging query, so the aging rows
 *     always add up to the tile (US1.1–1.3), shares of AMOUNT summing to 100;
 *   - the method rows normalised to the six labels, adding up to the total;
 *   - the manager projection: no draft rows, no record-payment action (US4.1);
 *   - a DB fault never throws: a typed error carrying a reference id, the
 *     same id logged with `err: errKind(e)` (US5.3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';

const loggerError = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => loggerError(...args), warn: vi.fn(), info: vi.fn() },
}));

import {
  loadInvoiceDashboardAging,
  loadInvoiceDashboardAttention,
  loadInvoiceDashboardMethods,
  loadInvoiceDashboardOldestOverdue,
  loadInvoiceDashboardTiles,
  loadInvoiceDashboardTrend,
  OLDEST_OVERDUE_DEFAULT_LIMIT,
  type InvoiceDashboardLoadInput,
  type LoadInvoiceDashboardDeps,
} from '@/modules/insights/application/use-cases/load-invoice-dashboard';
import type { InvoiceDashboardSource } from '@/modules/insights/application/ports/invoice-dashboard-source';
import { fiscalYearDateRange } from '@/modules/insights/domain/invoice-dashboard-fiscal-year';
import type { InvoiceDashboardFilters } from '@/modules/insights/domain/invoice-dashboard-filters';

const ctx = asTenantContext('test-tenant');

const FILTERS: InvoiceDashboardFilters = {
  type: 'membership',
  fiscalYear: 2026,
  planId: 'gold',
  origin: 'manual',
};

function input(over: Partial<InvoiceDashboardLoadInput> = {}): InvoiceDashboardLoadInput {
  return {
    filters: FILTERS,
    today: '2026-06-15',
    // FY 2026 starting in April: 2026-04-01 … 2027-03-31.
    fiscalYearRange: fiscalYearDateRange(2026, 4),
    canWrite: true,
    ...over,
  };
}

function stubSource(over: Partial<InvoiceDashboardSource> = {}): InvoiceDashboardSource {
  return {
    outstandingByAgingBucket: vi.fn().mockResolvedValue([]),
    collectedInRange: vi.fn().mockResolvedValue({ amountSatang: 0n, invoiceCount: 0 }),
    collectedByMethod: vi.fn().mockResolvedValue([]),
    monthlyBilledCollected: vi.fn().mockResolvedValue([]),
    attentionCounts: vi.fn().mockResolvedValue({
      manualDrafts: 0,
      autoRenewalDrafts: 0,
      receiptPdfFailed: 0,
      refundsFailedAtStripe: 0,
      refundsSettledUnbooked: 0,
    }),
    oldestOverdue: vi.fn().mockResolvedValue([]),
    ...over,
  };
}

function deps(source: InvoiceDashboardSource): LoadInvoiceDashboardDeps {
  return { source, newReferenceId: () => 'ref-123' };
}

beforeEach(() => {
  loggerError.mockReset();
});

describe('loadInvoiceDashboardTiles', () => {
  it('Outstanding = Σ every aging bucket; Overdue = Σ all but not-yet-due (an invoice due today is not overdue)', async () => {
    const source = stubSource({
      outstandingByAgingBucket: vi.fn().mockResolvedValue([
        { bucket: 'not_yet_due', amountSatang: 100_00n, count: 1 },
        { bucket: 'days_1_30', amountSatang: 200_00n, count: 2 },
        { bucket: 'over_90', amountSatang: 400_00n, count: 1 },
      ]),
    });
    const result = await loadInvoiceDashboardTiles(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outstanding).toEqual({ amountSatang: 700_00n, count: 4 });
    expect(result.value.overdue).toEqual({ amountSatang: 600_00n, count: 3 });
    expect(source.outstandingByAgingBucket).toHaveBeenCalledWith(ctx, FILTERS, '2026-06-15');
  });

  it('Collected this month is the calendar month of today, whatever fiscal year is selected', async () => {
    const collectedInRange = vi
      .fn()
      .mockResolvedValueOnce({ amountSatang: 50_00n, invoiceCount: 2 })
      .mockResolvedValueOnce({ amountSatang: 900_00n, invoiceCount: 9 });
    const source = stubSource({ collectedInRange });
    // A past FY is selected: the month tile must not follow it.
    const result = await loadInvoiceDashboardTiles(
      ctx,
      input({ fiscalYearRange: fiscalYearDateRange(2024, 4) }),
      deps(source),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(collectedInRange).toHaveBeenNthCalledWith(1, ctx, FILTERS, {
      from: '2026-06-01',
      to: '2026-06-30',
    });
    expect(result.value.collectedThisMonth).toEqual({
      amountSatang: 50_00n,
      invoiceCount: 2,
      range: { from: '2026-06-01', to: '2026-06-30' },
    });
    // A finished FY is read whole and is not "to date".
    expect(collectedInRange).toHaveBeenNthCalledWith(2, ctx, FILTERS, {
      from: '2024-04-01',
      to: '2025-03-31',
    });
    expect(result.value.collectedInFiscalYear).toEqual({
      amountSatang: 900_00n,
      invoiceCount: 9,
      range: { from: '2024-04-01', to: '2025-03-31' },
      toDate: false,
    });
  });

  it('the current FY is clamped to today ("to date")', async () => {
    const collectedInRange = vi.fn().mockResolvedValue({ amountSatang: 1n, invoiceCount: 1 });
    const result = await loadInvoiceDashboardTiles(
      ctx,
      input(),
      deps(stubSource({ collectedInRange })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(collectedInRange).toHaveBeenNthCalledWith(2, ctx, FILTERS, {
      from: '2026-04-01',
      to: '2026-06-15',
    });
    expect(result.value.collectedInFiscalYear.toDate).toBe(true);
  });

  it('December rolls the month range into the next year correctly', async () => {
    const collectedInRange = vi.fn().mockResolvedValue({ amountSatang: 0n, invoiceCount: 0 });
    await loadInvoiceDashboardTiles(
      ctx,
      input({ today: '2026-12-31' }),
      deps(stubSource({ collectedInRange })),
    );
    expect(collectedInRange).toHaveBeenNthCalledWith(1, ctx, FILTERS, {
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});

describe('loadInvoiceDashboardAging', () => {
  it('returns the five buckets in order, zero-filled, adding up to the total, with shares of AMOUNT summing to 100', async () => {
    const source = stubSource({
      outstandingByAgingBucket: vi.fn().mockResolvedValue([
        { bucket: 'over_90', amountSatang: 1_00n, count: 5 },
        { bucket: 'not_yet_due', amountSatang: 299_00n, count: 1 },
      ]),
    });
    const result = await loadInvoiceDashboardAging(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { buckets, totalSatang, count } = result.value;
    expect(buckets.map((b) => b.bucket)).toEqual([
      'not_yet_due',
      'days_1_30',
      'days_31_60',
      'days_61_90',
      'over_90',
    ]);
    expect(totalSatang).toBe(300_00n);
    expect(count).toBe(6);
    expect(buckets.reduce((s, b) => s + b.amountSatang, 0n)).toBe(totalSatang);
    // Share of amount, not of count: 5 of 6 invoices but 1/300 of the money.
    expect(buckets.map((b) => b.sharePercent)).toEqual([100, 0, 0, 0, 0]);
    expect(buckets[0]?.dueRange).toEqual({ dueAfter: '2026-06-15' });
    expect(buckets[1]?.dueRange).toEqual({ dueAfter: '2026-05-16', dueBefore: '2026-06-15' });
    expect(buckets[4]).toMatchObject({ amountSatang: 1_00n, count: 5, dueRange: { dueBefore: '2026-03-17' } });
  });

  it('shares sum to exactly 100 when amounts do not divide evenly', async () => {
    const source = stubSource({
      outstandingByAgingBucket: vi.fn().mockResolvedValue([
        { bucket: 'not_yet_due', amountSatang: 1n, count: 1 },
        { bucket: 'days_1_30', amountSatang: 1n, count: 1 },
        { bucket: 'days_31_60', amountSatang: 1n, count: 1 },
      ]),
    });
    const result = await loadInvoiceDashboardAging(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buckets.reduce((s, b) => s + b.sharePercent, 0)).toBe(100);
  });
});

describe('loadInvoiceDashboardAttention — role projection on the server', () => {
  const counts = {
    manualDrafts: 3,
    autoRenewalDrafts: 4,
    receiptPdfFailed: 1,
    refundsFailedAtStripe: 2,
    refundsSettledUnbooked: 5,
  };

  it('an admin (canWrite) gets all five counts', async () => {
    const source = stubSource({ attentionCounts: vi.fn().mockResolvedValue(counts) });
    const result = await loadInvoiceDashboardAttention(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      receiptPdfFailed: 1,
      refundsFailedAtStripe: 2,
      refundsSettledUnbooked: 5,
      drafts: { manual: 3, autoRenewal: 4 },
    });
    expect(source.attentionCounts).toHaveBeenCalledWith(ctx, FILTERS);
  });

  it('a manager (no write) gets the three read-only counts; the draft rows are ABSENT, not zeroed', async () => {
    const source = stubSource({ attentionCounts: vi.fn().mockResolvedValue(counts) });
    const result = await loadInvoiceDashboardAttention(ctx, input({ canWrite: false }), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      receiptPdfFailed: 1,
      refundsFailedAtStripe: 2,
      refundsSettledUnbooked: 5,
    });
    expect('drafts' in result.value).toBe(false);
    expect(JSON.stringify(result.value)).not.toMatch(/draft/i);
  });
});

describe('loadInvoiceDashboardOldestOverdue', () => {
  const row = {
    invoiceId: 'inv-1',
    documentNumber: 'INV-1',
    buyerName: 'Acme',
    dueDate: '2026-01-01',
    daysPastDue: 165,
    amountSatang: 10_700n,
  };

  it('threads today and the default limit; an admin may record payment', async () => {
    const source = stubSource({ oldestOverdue: vi.fn().mockResolvedValue([row]) });
    const result = await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(source.oldestOverdue).toHaveBeenCalledWith(
      ctx,
      FILTERS,
      '2026-06-15',
      OLDEST_OVERDUE_DEFAULT_LIMIT,
    );
    expect(result.value).toEqual({ rows: [row], canRecordPayment: true });
  });

  it('a manager sees the rows without the record-payment action; a caller limit is honoured', async () => {
    const source = stubSource({ oldestOverdue: vi.fn().mockResolvedValue([row]) });
    const result = await loadInvoiceDashboardOldestOverdue(
      ctx,
      input({ canWrite: false }),
      deps(source),
      6,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(source.oldestOverdue).toHaveBeenCalledWith(ctx, FILTERS, '2026-06-15', 6);
    expect(result.value.canRecordPayment).toBe(false);
  });

  it('an out-of-range limit falls back to the default', async () => {
    const source = stubSource();
    await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source), 0);
    await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source), 1.5);
    await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source), 51);
    for (const call of vi.mocked(source.oldestOverdue).mock.calls) {
      expect(call[3]).toBe(OLDEST_OVERDUE_DEFAULT_LIMIT);
    }
  });
});

describe('loadInvoiceDashboardTrend', () => {
  it('returns the FY 12 month slots: past and current filled (0 when absent), future empty', async () => {
    const source = stubSource({
      monthlyBilledCollected: vi.fn().mockResolvedValue([
        { monthKey: '2026-04', billedSatang: 500n, collectedSatang: 300n },
        { monthKey: '2026-06', billedSatang: -20n, collectedSatang: 40n },
      ]),
    });
    const result = await loadInvoiceDashboardTrend(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(source.monthlyBilledCollected).toHaveBeenCalledWith(ctx, FILTERS, {
      from: '2026-04-01',
      to: '2027-03-31',
    });
    const { slots } = result.value;
    expect(slots).toHaveLength(12);
    expect(slots[0]).toMatchObject({ monthKey: '2026-04', state: 'past', billedSatang: 500n, collectedSatang: 300n });
    expect(slots[1]).toMatchObject({ monthKey: '2026-05', state: 'past', billedSatang: 0n, collectedSatang: 0n });
    expect(slots[2]).toMatchObject({ monthKey: '2026-06', state: 'current', billedSatang: -20n, collectedSatang: 40n });
    expect(slots[3]).toMatchObject({ monthKey: '2026-07', state: 'future', billedSatang: null, collectedSatang: null });
    expect(slots[11]).toMatchObject({ monthKey: '2027-03', state: 'future', billedSatang: null });
  });
});

describe('loadInvoiceDashboardMethods', () => {
  it('normalises to the six method rows in order, adding up to the total, over the FY clamped to today', async () => {
    const source = stubSource({
      collectedByMethod: vi.fn().mockResolvedValue([
        { method: 'card', amountSatang: 1_000n },
        { method: 'bank_transfer', amountSatang: 5_000n },
        { method: 'promptpay', amountSatang: 300n },
        // An unknown legacy value and a NULL both land in "other" — never lost.
        { method: 'wire', amountSatang: 7n },
        { method: null, amountSatang: 3n },
        { method: 'other', amountSatang: 10n },
        { method: 'cash', amountSatang: -200n },
      ]),
    });
    const result = await loadInvoiceDashboardMethods(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(source.collectedByMethod).toHaveBeenCalledWith(ctx, FILTERS, {
      from: '2026-04-01',
      to: '2026-06-15',
    });
    expect(result.value.rows).toEqual([
      { method: 'bank_transfer', amountSatang: 5_000n },
      { method: 'promptpay', amountSatang: 300n },
      { method: 'card', amountSatang: 1_000n },
      { method: 'cheque', amountSatang: 0n },
      { method: 'cash', amountSatang: -200n },
      { method: 'other', amountSatang: 20n },
    ]);
    expect(result.value.totalSatang).toBe(6_120n);
    expect(result.value.range).toEqual({ from: '2026-04-01', to: '2026-06-15' });
  });
});

describe('a DB fault never throws: typed error + logged reference id', () => {
  const boom = () => vi.fn().mockRejectedValue(new TypeError('connection reset'));
  const cases = [
    ['tiles', (s: InvoiceDashboardSource) => loadInvoiceDashboardTiles(ctx, input(), deps(s)), { outstandingByAgingBucket: boom() }],
    ['tiles (collected)', (s: InvoiceDashboardSource) => loadInvoiceDashboardTiles(ctx, input(), deps(s)), { collectedInRange: boom() }],
    ['aging', (s: InvoiceDashboardSource) => loadInvoiceDashboardAging(ctx, input(), deps(s)), { outstandingByAgingBucket: boom() }],
    ['attention', (s: InvoiceDashboardSource) => loadInvoiceDashboardAttention(ctx, input(), deps(s)), { attentionCounts: boom() }],
    ['oldest overdue', (s: InvoiceDashboardSource) => loadInvoiceDashboardOldestOverdue(ctx, input(), deps(s)), { oldestOverdue: boom() }],
    ['trend', (s: InvoiceDashboardSource) => loadInvoiceDashboardTrend(ctx, input(), deps(s)), { monthlyBilledCollected: boom() }],
    ['methods', (s: InvoiceDashboardSource) => loadInvoiceDashboardMethods(ctx, input(), deps(s)), { collectedByMethod: boom() }],
  ] as const;

  for (const [name, run, over] of cases) {
    it(`${name}: err({ code: 'query_failed', referenceId }) and the same id logged with err: errKind(e)`, async () => {
      const result = await run(stubSource(over));
      expect(result).toEqual({ ok: false, error: { code: 'query_failed', referenceId: 'ref-123' } });
      expect(loggerError).toHaveBeenCalledTimes(1);
      const [fields, message] = loggerError.mock.calls[0] as [Record<string, unknown>, string];
      expect(fields).toMatchObject({ err: 'TypeError', referenceId: 'ref-123', tenantId: 'test-tenant' });
      // Only the error CLASS: the message may carry SQL fragments.
      expect(JSON.stringify(fields)).not.toContain('connection reset');
      expect(message).toMatch(/^insights\.invoice_dashboard\./);
    });
  }
});
