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
const NOW = new Date('2026-06-15T05:00:00Z');

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
    now: NOW,
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
      refundsPendingOverThreshold: 0,
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

  it('Collected this month is the calendar month of today, 1st to today, whatever fiscal year is selected', async () => {
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
    // "{Month} to date": the month is cut at today, never read to its last day.
    expect(collectedInRange).toHaveBeenNthCalledWith(1, ctx, FILTERS, {
      from: '2026-06-01',
      to: '2026-06-15',
    });
    expect(result.value.collectedThisMonth).toEqual({
      amountSatang: 50_00n,
      invoiceCount: 2,
      range: { from: '2026-06-01', to: '2026-06-15' },
      toDate: true,
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
    // Each bucket carries the invoice-list query its link opens (US2.2): a
    // status of issued / overdue only, so a link can never list paid or void.
    expect(buckets.map((b) => b.listQuery)).toEqual([
      { status: 'issued', dueAfter: '2026-06-15' },
      { status: 'overdue', dueAfter: '2026-05-16', dueBefore: '2026-06-15' },
      { status: 'overdue', dueAfter: '2026-04-16', dueBefore: '2026-05-16' },
      { status: 'overdue', dueAfter: '2026-03-17', dueBefore: '2026-04-16' },
      { status: 'overdue', dueBefore: '2026-03-17' },
    ]);
    expect(buckets[4]).toMatchObject({ amountSatang: 1_00n, count: 5 });
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
    refundsPendingOverThreshold: 5,
  };

  it('an admin (canWrite) gets all five counts', async () => {
    const source = stubSource({ attentionCounts: vi.fn().mockResolvedValue(counts) });
    const result = await loadInvoiceDashboardAttention(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      receiptPdfFailed: 1,
      refundsFailedAtStripe: 2,
      refundsPendingOverThreshold: 5,
      drafts: { manual: 3, autoRenewal: 4 },
    });
    expect(source.attentionCounts).toHaveBeenCalledWith(ctx, FILTERS, NOW);
  });

  it('a manager (no write) gets the three read-only counts; the draft rows are ABSENT, not zeroed', async () => {
    const source = stubSource({ attentionCounts: vi.fn().mockResolvedValue(counts) });
    const result = await loadInvoiceDashboardAttention(ctx, input({ canWrite: false }), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      receiptPdfFailed: 1,
      refundsFailedAtStripe: 2,
      refundsPendingOverThreshold: 5,
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
    // Spec US1: "Oldest overdue (6 rows)".
    expect(OLDEST_OVERDUE_DEFAULT_LIMIT).toBe(6);
    expect(source.oldestOverdue).toHaveBeenCalledWith(ctx, FILTERS, '2026-06-15', 6);
    expect(result.value).toEqual({ rows: [row], canRecordPayment: true });
  });

  it('a manager sees the rows without the record-payment action; a caller limit is honoured', async () => {
    const source = stubSource({ oldestOverdue: vi.fn().mockResolvedValue([row]) });
    const result = await loadInvoiceDashboardOldestOverdue(
      ctx,
      input({ canWrite: false }),
      deps(source),
      3,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 3: the phone's count (plan.md), distinct from the default.
    expect(source.oldestOverdue).toHaveBeenCalledWith(ctx, FILTERS, '2026-06-15', 3);
    expect(result.value.canRecordPayment).toBe(false);
  });

  it('an out-of-range limit falls back to the default', async () => {
    const source = stubSource();
    await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source), 0);
    await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source), 1.5);
    await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source), 51);
    await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source), 50);
    await loadInvoiceDashboardOldestOverdue(ctx, input(), deps(source), 1);
    // Out of range → the default (6); the 1–50 bounds themselves are kept.
    expect(vi.mocked(source.oldestOverdue).mock.calls.map((c) => c[3])).toEqual([6, 6, 6, 50, 1]);
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
    // Billed over the whole FY; Collected over the FY clamped to today, as the tile.
    expect(source.monthlyBilledCollected).toHaveBeenCalledWith(
      ctx,
      FILTERS,
      { from: '2026-04-01', to: '2027-03-31' },
      { from: '2026-04-01', to: '2026-06-15' },
    );
    expect(result.value.range).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    // The caption needs the Collected series' own range, cut at today.
    expect(result.value.collectedRange).toEqual({ from: '2026-04-01', to: '2026-06-15' });
    expect(result.value.toDate).toBe(true);
    const { slots } = result.value;
    expect(slots).toHaveLength(12);
    expect(slots[0]).toMatchObject({ monthKey: '2026-04', state: 'past', billedSatang: 500n, collectedSatang: 300n });
    expect(slots[1]).toMatchObject({ monthKey: '2026-05', state: 'past', billedSatang: 0n, collectedSatang: 0n });
    expect(slots[2]).toMatchObject({ monthKey: '2026-06', state: 'current', billedSatang: -20n, collectedSatang: 40n });
    expect(slots[3]).toMatchObject({ monthKey: '2026-07', state: 'future', billedSatang: null, collectedSatang: null });
    expect(slots[11]).toMatchObject({ monthKey: '2027-03', state: 'future', billedSatang: null });
  });
});

describe('loadInvoiceDashboardTrend — a finished FY', () => {
  it('reads Collected over the whole FY and is not "to date"', async () => {
    const source = stubSource();
    const result = await loadInvoiceDashboardTrend(
      ctx,
      input({ fiscalYearRange: fiscalYearDateRange(2024, 4) }),
      deps(source),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.collectedRange).toEqual({ from: '2024-04-01', to: '2025-03-31' });
    expect(result.value.toDate).toBe(false);
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
      { method: 'bank_transfer', amountSatang: 5_000n, sharePercent: 0 },
      { method: 'promptpay', amountSatang: 300n, sharePercent: 0 },
      { method: 'card', amountSatang: 1_000n, sharePercent: 0 },
      { method: 'cheque', amountSatang: 0n, sharePercent: 0 },
      { method: 'cash', amountSatang: -200n, sharePercent: 0 },
      { method: 'other', amountSatang: 20n, sharePercent: 0 },
    ]);
    expect(result.value.totalSatang).toBe(6_120n);
    expect(result.value.range).toEqual({ from: '2026-04-01', to: '2026-06-15' });
    expect(result.value.toDate).toBe(true);
    // A negative row has no part-to-whole reading: allocatePercentages refuses
    // the whole allocation, so every share is 0 (never a share above 100%).
    expect(result.value.rows.map((r) => r.sharePercent)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('each row carries its largest-remainder share of AMOUNT, adding to 100', async () => {
    const source = stubSource({
      collectedByMethod: vi.fn().mockResolvedValue([
        { method: 'bank_transfer', amountSatang: 1n },
        { method: 'promptpay', amountSatang: 1n },
        { method: 'card', amountSatang: 1n },
      ]),
    });
    const result = await loadInvoiceDashboardMethods(
      ctx,
      input({ fiscalYearRange: fiscalYearDateRange(2024, 4) }),
      deps(source),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((r) => r.sharePercent)).toEqual([34, 33, 33, 0, 0, 0]);
    expect(result.value.toDate).toBe(false);
  });

  it('a negative row (credit notes on last FY invoices) gets 0; the positive rows share 100', async () => {
    const source = stubSource({
      collectedByMethod: vi.fn().mockResolvedValue([
        { method: 'card', amountSatang: 200_000n },
        { method: 'promptpay', amountSatang: 100_000n },
        { method: 'bank_transfer', amountSatang: -50_000n },
      ]),
    });
    const result = await loadInvoiceDashboardMethods(ctx, input(), deps(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const share = (m: string) => result.value.rows.find((r) => r.method === m)?.sharePercent;
    expect(share('card')).toBe(67);
    expect(share('promptpay')).toBe(33);
    expect(share('bank_transfer')).toBe(0);
    const positives = result.value.rows.filter((r) => r.amountSatang > 0n);
    expect(positives.reduce((s, r) => s + r.sharePercent, 0)).toBe(100);
    // The amounts are untouched: the rows still add up to the tile.
    expect(result.value.totalSatang).toBe(250_000n);
  });

  it('no money collected: every share is 0', async () => {
    const result = await loadInvoiceDashboardMethods(ctx, input(), deps(stubSource()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.every((r) => r.sharePercent === 0)).toBe(true);
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
