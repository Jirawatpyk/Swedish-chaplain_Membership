import { describe, it, expect } from 'vitest';
import { getDateFormatLocale, formatLocalisedDate } from '@/lib/format-date-localised';

describe('getDateFormatLocale', () => {
  it('maps th → th-TH-u-ca-buddhist', () => {
    expect(getDateFormatLocale('th')).toBe('th-TH-u-ca-buddhist');
    expect(getDateFormatLocale('th-TH')).toBe('th-TH-u-ca-buddhist');
  });
  it('maps sv → sv-SE', () => {
    expect(getDateFormatLocale('sv')).toBe('sv-SE');
    expect(getDateFormatLocale('sv-SE')).toBe('sv-SE');
  });
  it('passes en through unchanged', () => {
    expect(getDateFormatLocale('en')).toBe('en');
  });
});

describe('formatLocalisedDate', () => {
  const iso = '2026-05-29T00:00:00.000Z';
  it('renders the Buddhist-Era year for th (2569, Arabic numerals)', () => {
    const out = formatLocalisedDate(iso, 'th', { year: 'numeric', month: 'short', day: 'numeric' });
    expect(out).toContain('2569');
    expect(out).not.toContain('๒๕๖๙');
  });
  it('renders Gregorian for en', () => {
    const out = formatLocalisedDate(iso, 'en', { year: 'numeric', month: 'short', day: 'numeric' });
    expect(out).toContain('2026');
  });
  it('sv output is identical to bare-sv (no regression from sv→sv-SE)', () => {
    const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };
    const d = new Date(iso);
    const viaHelper = formatLocalisedDate(iso, 'sv', opts);
    const bareSv = new Intl.DateTimeFormat('sv', opts).format(d);
    expect(viaHelper).toBe(bareSv);
  });
  it('returns — for an invalid date', () => {
    expect(formatLocalisedDate('not-a-date', 'en')).toBe('—');
  });
});
