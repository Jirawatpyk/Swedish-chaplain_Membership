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
  it('returns the raw string for a malformed date', () => {
    expect(formatTaxDocDate('nope', 'th')).toBe('nope');
  });
});
