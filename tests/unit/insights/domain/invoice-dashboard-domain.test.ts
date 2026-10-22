/**
 * 124 slice 2 — the invoice dashboard's pure domain rules: URL filter state
 * (US3), the aging bucket of a due date (US1.3, US2.2) and the fiscal-year
 * date range with its 12 month slots (US3.3, § Figure definitions).
 */
import { describe, expect, it } from 'vitest';
import { computeIsOverdue } from '@/modules/invoicing';
import {
  parseInvoiceDashboardFilters,
  selectableFiscalYears,
} from '@/modules/insights/domain/invoice-dashboard-filters';
import {
  AGING_BUCKETS,
  agingBucketDueRange,
  agingBucketOf,
} from '@/modules/insights/domain/invoice-dashboard-aging';
import {
  fiscalYearDateRange,
  fiscalYearMonthSlots,
} from '@/modules/insights/domain/invoice-dashboard-fiscal-year';

describe('parseInvoiceDashboardFilters', () => {
  const ctx = { currentFiscalYear: 2026, autoInvoiceEnabled: true };

  it('no params → every filter at its default', () => {
    expect(parseInvoiceDashboardFilters({}, ctx)).toEqual({
      type: 'all',
      fiscalYear: 2026,
      planId: null,
      origin: 'all',
    });
  });

  it('reads type, fy and origin in the invoice list vocabulary', () => {
    expect(
      parseInvoiceDashboardFilters({ type: 'event', fy: '2025', origin: 'auto_renewal' }, ctx),
    ).toEqual({ type: 'event', fiscalYear: 2025, planId: null, origin: 'auto_renewal' });
    expect(parseInvoiceDashboardFilters({ type: 'membership', origin: 'manual' }, ctx)).toMatchObject({
      type: 'membership',
      origin: 'manual',
    });
  });

  it('a Plan sets Invoice type to Membership', () => {
    expect(parseInvoiceDashboardFilters({ plan: 'gold' }, ctx)).toMatchObject({
      type: 'membership',
      planId: 'gold',
    });
    expect(parseInvoiceDashboardFilters({ type: 'membership', plan: 'gold' }, ctx)).toMatchObject({
      type: 'membership',
      planId: 'gold',
    });
  });

  it('Invoice type = Events drops the plan', () => {
    expect(parseInvoiceDashboardFilters({ type: 'event', plan: 'gold' }, ctx)).toMatchObject({
      type: 'event',
      planId: null,
    });
  });

  it('an unknown plan id passes through as-is (D-i: it filters, never widens)', () => {
    expect(parseInvoiceDashboardFilters({ plan: 'gold-2019' }, ctx).planId).toBe('gold-2019');
  });

  it('an empty or over-long plan id is ignored, as on the invoice list', () => {
    expect(parseInvoiceDashboardFilters({ plan: '' }, ctx)).toMatchObject({ type: 'all', planId: null });
    expect(parseInvoiceDashboardFilters({ plan: 'x'.repeat(64) }, ctx).planId).toBe('x'.repeat(64));
    expect(parseInvoiceDashboardFilters({ plan: 'x'.repeat(65) }, ctx)).toMatchObject({
      type: 'all',
      planId: null,
    });
  });

  it('the FY window is the current FY and the two before; anything else → current', () => {
    expect(selectableFiscalYears(2026)).toEqual([2026, 2025, 2024]);
    expect(parseInvoiceDashboardFilters({ fy: '2024' }, ctx).fiscalYear).toBe(2024);
    for (const fy of ['2023', '2027', '26', '2025.0', ' 2025', 'abc', '']) {
      expect(parseInvoiceDashboardFilters({ fy }, ctx).fiscalYear).toBe(2026);
    }
  });

  it('unknown type or origin values → defaults', () => {
    expect(parseInvoiceDashboardFilters({ type: 'Membership', origin: 'auto' }, ctx)).toMatchObject({
      type: 'all',
      origin: 'all',
    });
  });

  it('a repeated param is not a value → default', () => {
    expect(
      parseInvoiceDashboardFilters({ type: ['event', 'membership'], fy: ['2025'], plan: ['gold'] }, ctx),
    ).toEqual({ type: 'all', fiscalYear: 2026, planId: null, origin: 'all' });
  });

  it('origin is honoured only while auto-invoicing is on', () => {
    const off = { currentFiscalYear: 2026, autoInvoiceEnabled: false };
    expect(parseInvoiceDashboardFilters({ origin: 'auto_renewal' }, off).origin).toBe('all');
    expect(parseInvoiceDashboardFilters({ origin: 'manual' }, off).origin).toBe('all');
  });
});

describe('agingBucketOf', () => {
  const today = '2026-10-22';
  const cases: readonly [daysPastDue: number, dueDate: string, bucket: string][] = [
    [-30, '2026-11-21', 'not_yet_due'],
    [-1, '2026-10-23', 'not_yet_due'],
    [0, '2026-10-22', 'not_yet_due'],
    [1, '2026-10-21', 'days_1_30'],
    [30, '2026-09-22', 'days_1_30'],
    [31, '2026-09-21', 'days_31_60'],
    [60, '2026-08-23', 'days_31_60'],
    [61, '2026-08-22', 'days_61_90'],
    [90, '2026-07-24', 'days_61_90'],
    [91, '2026-07-23', 'over_90'],
    [400, '2025-09-17', 'over_90'],
  ];

  it.each(cases)('%i days past due (due %s) → %s', (_days, dueDate, bucket) => {
    expect(agingBucketOf(dueDate, today)).toBe(bucket);
  });

  it.each(cases)('%i days past due: overdue exactly when computeIsOverdue says so', (_d, dueDate) => {
    // Late evening in Bangkok on `today` (16:59 UTC = 23:59 +07).
    const nowUtcIso = '2026-10-22T16:59:00.000Z';
    const invoice = { status: 'issued', dueDate } as unknown as Parameters<typeof computeIsOverdue>[0];
    expect(agingBucketOf(dueDate, today) !== 'not_yet_due').toBe(computeIsOverdue(invoice, nowUtcIso));
  });

  it('crosses a month and a leap day by calendar days', () => {
    // 2028-03-01 − 30 days = 2028-01-31 (February 2028 has 29 days).
    expect(agingBucketOf('2028-01-31', '2028-03-01')).toBe('days_1_30');
    expect(agingBucketOf('2028-01-30', '2028-03-01')).toBe('days_31_60');
  });
});

describe('agingBucketDueRange', () => {
  const today = '2026-10-22';

  it('gives the invoice-list range of each bucket (dueAfter inclusive, dueBefore exclusive)', () => {
    expect(agingBucketDueRange('not_yet_due', today)).toEqual({ dueAfter: '2026-10-22' });
    expect(agingBucketDueRange('days_1_30', today)).toEqual({
      dueAfter: '2026-09-22',
      dueBefore: '2026-10-22',
    });
    expect(agingBucketDueRange('days_31_60', today)).toEqual({
      dueAfter: '2026-08-23',
      dueBefore: '2026-09-22',
    });
    expect(agingBucketDueRange('days_61_90', today)).toEqual({
      dueAfter: '2026-07-24',
      dueBefore: '2026-08-23',
    });
    expect(agingBucketDueRange('over_90', today)).toEqual({ dueBefore: '2026-07-24' });
  });

  it('every due date falls in the range of exactly the bucket agingBucketOf names', () => {
    const inRange = (due: string, r: { dueAfter?: string; dueBefore?: string }) =>
      (r.dueAfter === undefined || due >= r.dueAfter) && (r.dueBefore === undefined || due < r.dueBefore);
    for (const due of ['2026-11-01', '2026-10-22', '2026-10-21', '2026-09-22', '2026-09-21', '2026-07-24', '2026-07-23']) {
      const matching = AGING_BUCKETS.filter((b) => inRange(due, agingBucketDueRange(b, today)));
      expect(matching).toEqual([agingBucketOf(due, today)]);
    }
  });

  it('lists the five buckets in display order', () => {
    expect(AGING_BUCKETS).toEqual(['not_yet_due', 'days_1_30', 'days_31_60', 'days_61_90', 'over_90']);
  });
});

describe('fiscalYearDateRange', () => {
  it('January start: the calendar year', () => {
    expect(fiscalYearDateRange(2026, 1)).toEqual({ fiscalYear: 2026, from: '2026-01-01', to: '2026-12-31' });
  });

  it('April start: 1 Apr of the FY year to 31 Mar of the next', () => {
    expect(fiscalYearDateRange(2026, 4)).toEqual({ fiscalYear: 2026, from: '2026-04-01', to: '2027-03-31' });
  });

  it('March start ends on a leap day when the next February has one', () => {
    expect(fiscalYearDateRange(2027, 3)).toEqual({ fiscalYear: 2027, from: '2027-03-01', to: '2028-02-29' });
  });
});

describe('fiscalYearMonthSlots', () => {
  it('January start: 12 calendar months, past / current / future around today', () => {
    const slots = fiscalYearMonthSlots(2026, 1, '2026-10-22');
    expect(slots).toHaveLength(12);
    expect(slots[0]).toEqual({ monthKey: '2026-01', from: '2026-01-01', to: '2026-01-31', state: 'past' });
    expect(slots[1]).toEqual({ monthKey: '2026-02', from: '2026-02-01', to: '2026-02-28', state: 'past' });
    expect(slots[9]).toEqual({ monthKey: '2026-10', from: '2026-10-01', to: '2026-10-31', state: 'current' });
    expect(slots[11]).toEqual({ monthKey: '2026-12', from: '2026-12-01', to: '2026-12-31', state: 'future' });
    expect(slots.map((s) => s.state).filter((s) => s === 'current')).toHaveLength(1);
  });

  it('April start with today in the second calendar year crosses the year', () => {
    const slots = fiscalYearMonthSlots(2026, 4, '2027-02-10');
    expect(slots.map((s) => s.monthKey)).toEqual([
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
      '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
    ]);
    expect(slots.map((s) => s.state)).toEqual([
      'past', 'past', 'past', 'past', 'past', 'past',
      'past', 'past', 'past', 'past', 'current', 'future',
    ]);
    expect(slots[10]).toMatchObject({ from: '2027-02-01', to: '2027-02-28' });
    expect(slots[11]).toMatchObject({ from: '2027-03-01', to: '2027-03-31' });
  });

  it('a past FY is all past; a future FY all future', () => {
    expect(new Set(fiscalYearMonthSlots(2024, 1, '2026-10-22').map((s) => s.state))).toEqual(new Set(['past']));
    expect(new Set(fiscalYearMonthSlots(2027, 1, '2026-10-22').map((s) => s.state))).toEqual(new Set(['future']));
  });

  it('the first and last day of a month are both that month current', () => {
    expect(fiscalYearMonthSlots(2026, 1, '2026-10-01')[9]?.state).toBe('current');
    expect(fiscalYearMonthSlots(2026, 1, '2026-10-31')[9]?.state).toBe('current');
    expect(fiscalYearMonthSlots(2026, 1, '2026-10-31')[10]?.state).toBe('future');
  });

  it('the slots tile the FY range with no gap', () => {
    const range = fiscalYearDateRange(2026, 7);
    const slots = fiscalYearMonthSlots(2026, 7, '2026-10-22');
    expect(slots[0]?.from).toBe(range.from);
    expect(slots[11]?.to).toBe(range.to);
  });
});
