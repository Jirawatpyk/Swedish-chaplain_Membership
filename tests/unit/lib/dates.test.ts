/**
 * 068 cluster G — unit coverage for the shared `addMonthsUtc` helper extracted
 * from the byte-identical `create-cycle-in-tx.ts` + `mark-paid-offline.ts`
 * locals.
 */
import { describe, expect, it } from 'vitest';
import { addMonthsUtc, bangkokDateOnly } from '@/lib/dates';

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
    // 068 R2-2 — month-end overflow CLAMPS to the last day of the target
    // month (Feb has no 31st → Feb 28 in 2026, NOT a roll into March). This
    // preserves the billing-period anniversary intent rather than drifting
    // forward a few days each time `setUTCMonth` overflows.
    expect(addMonthsUtc('2026-01-31T00:00:00.000Z', 1)).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('068 R2-2 — clamps Feb-29 (leap origin) + 12 months to Feb-28 of a non-leap year (no Mar-1 drift)', () => {
    // 2024 is a leap year; 2025 is not. Feb 29 2024 + 12 months lands in a
    // non-leap February → clamp to Feb 28 2025, NOT roll forward to Mar 1.
    expect(addMonthsUtc('2024-02-29T00:00:00.000Z', 12)).toBe(
      '2025-02-28T00:00:00.000Z',
    );
  });

  it('068 R2-2 — a leap-target advance keeps Feb-29 (Feb-28 origin → Feb-28 leap target unaffected)', () => {
    // A non-month-end day is never clamped: Feb 28 2024 + 12 months → Feb 28
    // 2025 (the day-of-month 28 exists in both Februaries).
    expect(addMonthsUtc('2024-02-28T00:00:00.000Z', 12)).toBe(
      '2025-02-28T00:00:00.000Z',
    );
  });

  it('068 R2-2 — clamps Jan-31 + 1 month across multiple steps without compounding drift', () => {
    // Jan 31 → clamp Feb 28 (one step). Re-advancing from the clamped result
    // by 12 months returns Feb 28 (stable; no further drift).
    const feb = addMonthsUtc('2026-01-31T00:00:00.000Z', 1);
    expect(feb).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonthsUtc(feb, 12)).toBe('2027-02-28T00:00:00.000Z');
  });

  it('does NOT clamp a non-overflowing day-of-month (preserves day + time)', () => {
    expect(addMonthsUtc('2026-01-15T08:30:00.000Z', 1)).toBe(
      '2026-02-15T08:30:00.000Z',
    );
  });

  it('crosses a year boundary correctly', () => {
    expect(addMonthsUtc('2026-12-01T00:00:00.000Z', 1)).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

// R2-FIX-7 (PR #173 round-2 review, 2026-07-09) — client-bundle-safe
// Asia/Bangkok (UTC+7, no DST) calendar-date helper, replacing js-joda's
// `bangkokLocalDate` in `'use client'` code. Must match `bangkokLocalDate`'s
// output for every instant.
describe('bangkokDateOnly', () => {
  it('returns the same calendar date within the Bangkok day (before the +7h roll)', () => {
    expect(bangkokDateOnly('2026-06-15T10:00:00.000Z')).toBe('2026-06-15');
  });

  it('rolls to the NEXT Bangkok date for a late-UTC instant (17:00–23:59 UTC is already tomorrow in Bangkok)', () => {
    // 2026-06-15T17:00Z + 7h = 2026-06-16T00:00 Bangkok → date rolls forward.
    expect(bangkokDateOnly('2026-06-15T17:00:00.000Z')).toBe('2026-06-16');
    expect(bangkokDateOnly('2026-06-15T23:59:00.000Z')).toBe('2026-06-16');
  });

  it('rolls a month/year boundary correctly (2026-12-31T20:00Z → 2027-01-01 Bangkok)', () => {
    expect(bangkokDateOnly('2026-12-31T20:00:00.000Z')).toBe('2027-01-01');
  });

  it('an exactly-17:00Z instant is the first moment of the next Bangkok day', () => {
    expect(bangkokDateOnly('2026-01-31T17:00:00.000Z')).toBe('2026-02-01');
  });
});
