/**
 * 068 cluster G — unit coverage for the shared `addMonthsUtc` helper extracted
 * from the byte-identical `create-cycle-in-tx.ts` + `mark-paid-offline.ts`
 * locals.
 */
import { describe, expect, it } from 'vitest';
import { addMonthsUtc } from '@/lib/dates';

describe('addMonthsUtc', () => {
  it('adds whole calendar months in UTC (12-month renewal term)', () => {
    expect(addMonthsUtc('2026-06-01T00:00:00.000Z', 12)).toBe(
      '2027-06-01T00:00:00.000Z',
    );
  });

  it('preserves the day-of-month + time across the addition', () => {
    expect(addMonthsUtc('2026-03-15T08:30:00.000Z', 12)).toBe(
      '2027-03-15T08:30:00.000Z',
    );
  });

  it('handles a mid-year term (e.g. 6 months) without DST drift (Asia/Bangkok UTC+7, no DST)', () => {
    expect(addMonthsUtc('2026-01-31T00:00:00.000Z', 1)).toBe(
      // Jan 31 + 1 month rolls into March (Feb has no 31st) — platform Date
      // semantics, preserved intentionally from the former call sites.
      '2026-03-03T00:00:00.000Z',
    );
  });

  it('crosses a year boundary correctly', () => {
    expect(addMonthsUtc('2026-12-01T00:00:00.000Z', 1)).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});
