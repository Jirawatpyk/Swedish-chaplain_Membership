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
  it('returns em-dash for an out-of-bounds date (month 99)', () => {
    expect(formatTaxDocDate('2026-99-99', 'th')).toBe('—');
  });
});
