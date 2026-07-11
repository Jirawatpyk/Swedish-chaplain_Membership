import { describe, expect, it } from 'vitest';
import {
  bkkYearMonth,
  addMonthsToYm,
  bkkMonthStartInstant,
  buildMonthWindow,
  foldRawMonths,
  buildRenewalMonthSummary,
  parseMonthParam,
  barWidthPercent,
  MIN_BAR_PERCENT,
} from '@/modules/renewals/domain/renewal-month-bucket';

describe('bkkYearMonth — Asia/Bangkok wall-clock month', () => {
  it('maps a +07 midnight cycle to its BKK month (host-TZ independent)', () => {
    // 2026-12-01T00:00+07 === 2026-11-30T17:00Z; BKK wall-clock month is 2026-12.
    expect(bkkYearMonth('2026-12-01T00:00:00+07:00')).toBe('2026-12');
    expect(bkkYearMonth('2026-11-30T17:00:00Z')).toBe('2026-12');
  });
  it('does not roll a late-UTC instant back a month in BKK', () => {
    // 2026-06-30T18:00Z === 2026-07-01T01:00+07 → BKK month 2026-07.
    expect(bkkYearMonth('2026-06-30T18:00:00Z')).toBe('2026-07');
  });
});

describe('addMonthsToYm', () => {
  it('adds within a year', () => {
    expect(addMonthsToYm('2026-07', 3)).toBe('2026-10');
  });
  it('crosses the December→January boundary', () => {
    expect(addMonthsToYm('2026-11', 2)).toBe('2027-01');
    expect(addMonthsToYm('2026-07', 12)).toBe('2027-07');
  });
  it('subtracts for a negative n, including across a year boundary', () => {
    expect(addMonthsToYm('2026-01', -1)).toBe('2025-12');
    expect(addMonthsToYm('2026-03', -5)).toBe('2025-10');
  });
});

describe('bkkMonthStartInstant', () => {
  it('is the UTC instant of the 1st at 00:00 +07', () => {
    expect(bkkMonthStartInstant('2026-12').toISOString()).toBe(
      '2026-11-30T17:00:00.000Z',
    );
  });
});

describe('buildMonthWindow', () => {
  it('returns 12 chronological keys starting at the current BKK month', () => {
    const w = buildMonthWindow('2026-07-10T05:00:00Z'); // BKK 2026-07-10 12:00
    expect(w).toHaveLength(12);
    expect(w[0]).toBe('2026-07');
    expect(w[11]).toBe('2027-06');
  });
});

describe('foldRawMonths', () => {
  const now = '2026-07-10T05:00:00Z'; // BKK month 2026-07; later threshold 2027-07
  it('splits past → overdue, in-window → months, >=+12mo → later', () => {
    const agg = foldRawMonths(
      [
        { month: '2026-05', count: 3 }, // overdue
        { month: '2026-06', count: 2 }, // overdue
        { month: '2026-07', count: 5 }, // window m0
        { month: '2027-02', count: 4 }, // window
        { month: '2027-07', count: 6 }, // later (== +12mo)
        { month: '2028-01', count: 1 }, // later
      ],
      now,
    );
    expect(agg.overdueCount).toBe(5);
    expect(agg.laterCount).toBe(7);
    expect(agg.months).toEqual([
      { month: '2026-07', count: 5 },
      { month: '2027-02', count: 4 },
    ]);
  });
});

describe('buildRenewalMonthSummary', () => {
  const now = '2026-07-10T05:00:00Z';
  it('produces 14 ordered zero-filled buckets with max + total', () => {
    const summary = buildRenewalMonthSummary(
      {
        overdueCount: 2,
        months: [
          { month: '2026-07', count: 17 },
          { month: '2026-09', count: 3 },
        ],
        laterCount: 1,
      },
      now,
    );
    expect(summary.buckets).toHaveLength(14);
    expect(summary.buckets[0]).toEqual({ key: 'overdue', count: 2 });
    expect(summary.buckets[1]).toEqual({ key: '2026-07', count: 17 });
    expect(summary.buckets[2]).toEqual({ key: '2026-08', count: 0 }); // zero-filled
    expect(summary.buckets[3]).toEqual({ key: '2026-09', count: 3 });
    expect(summary.buckets[13]).toEqual({ key: 'later', count: 1 });
    expect(summary.maxCount).toBe(17);
    expect(summary.totalCount).toBe(23);
  });
});

describe('parseMonthParam', () => {
  it('accepts overdue / later / valid YYYY-MM', () => {
    expect(parseMonthParam('overdue')).toBe('overdue');
    expect(parseMonthParam('later')).toBe('later');
    expect(parseMonthParam('2027-01')).toBe('2027-01');
  });
  it('rejects garbage / out-of-range month → null', () => {
    expect(parseMonthParam('2026-13')).toBeNull();
    expect(parseMonthParam('2026-00')).toBeNull();
    expect(parseMonthParam('nope')).toBeNull();
    expect(parseMonthParam(undefined)).toBeNull();
    expect(parseMonthParam(null)).toBeNull();
  });
});

describe('barWidthPercent', () => {
  it('scales proportionally and floors nonzero to MIN_BAR_PERCENT', () => {
    expect(barWidthPercent(17, 17)).toBe(100);
    expect(barWidthPercent(2, 17)).toBeCloseTo(11.76, 1); // 17-vs-2 domination stays visible
    expect(barWidthPercent(1, 1000)).toBe(MIN_BAR_PERCENT); // tiny nonzero floored
    expect(barWidthPercent(0, 17)).toBe(0); // zero stays zero
    expect(barWidthPercent(5, 0)).toBe(0); // empty dataset guard
  });
  it('clamps to 100 when count exceeds maxCount', () => {
    expect(barWidthPercent(20, 17)).toBe(100);
  });
});
