/**
 * Month-year tax-document formatter — EN/SV Gregorian, TH Thai-month + Buddhist
 * Era. Used on the §86/4 membership line's coverage window ("August 2026 - July
 * 2027" / "สิงหาคม 2569 - กรกฎาคม 2570"). BE is display-only.
 */
import { describe, expect, it } from 'vitest';
import { formatTaxDocMonthYear } from '@/lib/format-tax-doc-month-year';

describe('formatTaxDocMonthYear', () => {
  it('renders the full English month name + Gregorian year', () => {
    expect(formatTaxDocMonthYear('2026-08-01', 'en')).toBe('August 2026');
    expect(formatTaxDocMonthYear('2027-07-15', 'en')).toBe('July 2027');
  });

  it('renders the Thai month name + Buddhist Era year (CE + 543)', () => {
    const s = formatTaxDocMonthYear('2026-08-01', 'th');
    expect(s).toContain('สิงหาคม');
    expect(s).toContain('2569'); // 2026 + 543
    expect(s).not.toContain('2026'); // BE only, no double-print
  });

  it('does not depend on the day-of-month (month+year only)', () => {
    expect(formatTaxDocMonthYear('2026-06-30', 'en')).toBe('June 2026');
    expect(formatTaxDocMonthYear('2026-06-01', 'en')).toBe('June 2026');
  });

  it('returns an em dash for an invalid date', () => {
    expect(formatTaxDocMonthYear('2026-13-01', 'en')).toBe('—');
    expect(formatTaxDocMonthYear('not-a-date', 'en')).toBe('—');
  });
});
