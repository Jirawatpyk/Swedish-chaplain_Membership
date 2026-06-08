import { describe, it, expect } from 'vitest';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';

describe('formatTaxDocDate', () => {
  const iso = '2026-05-29';
  it('th: Gregorian CE base + exactly one (พ.ศ.) suffix, no double-BE', () => {
    const out = formatTaxDocDate(iso, 'th');
    expect(out).toContain('2026');
    expect(out).toContain('(พ.ศ. 2569)');
    expect((out.match(/2569/g) ?? []).length).toBe(1);
    expect(out).toMatch(/พ\.ค\./);
  });
  it('en: Gregorian only, no (พ.ศ.)', () => {
    const out = formatTaxDocDate(iso, 'en');
    expect(out).toContain('2026');
    expect(out).not.toContain('พ.ศ.');
  });
  it('sv: Gregorian only, no (พ.ศ.)', () => {
    const out = formatTaxDocDate(iso, 'sv');
    expect(out).toContain('2026');
    expect(out).not.toContain('พ.ศ.');
  });
  it('sv: routes through getDateFormatLocale → sv-SE canonical locale', () => {
    const canonical = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 4, 29)));
    expect(formatTaxDocDate('2026-05-29', 'sv')).toBe(canonical);
  });
  it('UTC-pinned: the day does not shift', () => {
    expect(formatTaxDocDate('2026-05-29', 'en')).toContain('29');
    expect(formatTaxDocDate('2026-01-01', 'en')).toContain('1');
  });
  it('CE↔BE invariant: BE year = CE year + 543', () => {
    for (const y of [2024, 2025, 2026, 2027]) {
      const out = formatTaxDocDate(`${y}-06-15`, 'th');
      expect(out).toContain(`(พ.ศ. ${y + 543})`);
      expect(out).toContain(String(y));
    }
  });
  // R4 — invalid input must return em-dash '—', not the raw string
  it('returns em-dash for a malformed date (non-numeric)', () => {
    expect(formatTaxDocDate('nope', 'th')).toBe('—');
  });
  it('returns em-dash for an empty string', () => {
    expect(formatTaxDocDate('', 'th')).toBe('—');
  });
  // month/day-range reject (month 99 is out of 1–12 bound)
  it('returns em-dash for a month/day-range-invalid date (month 99)', () => {
    expect(formatTaxDocDate('2026-99-99', 'th')).toBe('—');
  });
  // year < 1 branch (currently untested)
  it('returns em-dash for year 0000 (year < 1 guard)', () => {
    expect(formatTaxDocDate('0000-05-29', 'th')).toBe('—');
  });
  // rollover-invalid dates: Date.UTC silently rolls Feb-30 → Mar 2
  it('returns em-dash for Feb 30 (rollover-invalid, th locale)', () => {
    expect(formatTaxDocDate('2026-02-30', 'th')).toBe('—');
  });
  it('returns em-dash for Apr 31 (rollover-invalid, en locale)', () => {
    expect(formatTaxDocDate('2026-04-31', 'en')).toBe('—');
  });
  // year-boundary UTC-pin: Dec 31 must not roll to Jan 1 of next year
  it('year-boundary UTC-pin: 2025-12-31 stays in 2025 CE and 2568 BE', () => {
    const out = formatTaxDocDate('2025-12-31', 'th');
    expect(out).toContain('2025');
    expect(out).toContain('(พ.ศ. 2568)');
    expect(out).toContain('31');
    expect(out).not.toContain('2026');
    expect(out).not.toContain('2569');
  });
});
