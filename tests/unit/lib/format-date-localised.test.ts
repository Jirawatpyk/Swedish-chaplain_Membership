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

  describe('UTC-pin (timeZone: UTC) for date-only Postgres date columns', () => {
    // Bare YYYY-MM-DD strings (Postgres `date` columns) are parsed by
    // `new Date()` as UTC midnight. Without `timeZone: 'UTC'` the rendered
    // day can shift by -1 on browsers/runtimes west of UTC (e.g. US admin
    // sees "Jan 14" instead of "Jan 15" for 2026-01-15). Pinning to UTC
    // keeps the displayed day stable regardless of runtime locale.
    const dateOnlyOpts: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    };

    it('contains the correct day (15) for 2026-01-15 with en + timeZone:UTC', () => {
      const out = formatLocalisedDate('2026-01-15', 'en', dateOnlyOpts);
      expect(out).toContain('15');
      expect(out).toContain('2026');
    });

    it('contains the correct day (1) for 2026-03-01 with en + timeZone:UTC', () => {
      const out = formatLocalisedDate('2026-03-01', 'en', dateOnlyOpts);
      expect(out).toContain('1');
      expect(out).toContain('2026');
    });

    it('th locale with timeZone:UTC still shows BE year (2569) and correct day', () => {
      // 2026 CE → 2569 BE; date 2026-05-15 must render day 15, year 2569
      const out = formatLocalisedDate('2026-05-15', 'th', dateOnlyOpts);
      expect(out).toContain('2569');
      expect(out).toContain('15');
    });
  });
});
