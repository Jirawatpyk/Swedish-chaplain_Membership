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
    // Compare against the SAME Bangkok zone the helper now defaults to
    // (2026-07-31 hydration fix), so this locale-mapping pin stays
    // deterministic on any process TZ.
    const bareSv = new Intl.DateTimeFormat('sv', {
      ...opts,
      timeZone: 'Asia/Bangkok',
    }).format(d);
    expect(viaHelper).toBe(bareSv);
  });
  it('returns — for an invalid date', () => {
    expect(formatLocalisedDate('not-a-date', 'en')).toBe('—');
  });

  describe('Bangkok timeZone default (2026-07-31 prod #418 hydration incident)', () => {
    // 18:30 UTC = 01:30 NEXT DAY in Asia/Bangkok — the shape that used to
    // format differently on the UTC server vs a Bangkok browser.
    const eveningUtc = '2026-07-30T18:30:00.000Z';

    it('defaults to Asia/Bangkok when options carry no timeZone (day = Jul 31, independent of process TZ)', () => {
      const out = formatLocalisedDate(eveningUtc, 'en', { dateStyle: 'medium' });
      expect(out).toContain('31');
      expect(out).not.toContain('30');
    });

    it('the default also pins the HOUR (01:30 Bangkok, never 18:30 UTC)', () => {
      const out = formatLocalisedDate(eveningUtc, 'en', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      expect(out).toContain('01:30');
    });

    it('an EXPLICIT options.timeZone still wins over the default (UTC anchor → Jul 30)', () => {
      const out = formatLocalisedDate(eveningUtc, 'en', {
        dateStyle: 'medium',
        timeZone: 'UTC',
      });
      expect(out).toContain('30');
      expect(out).not.toContain('31');
    });

    it('date-ONLY ISO strings were already safe either way (UTC midnight = 7am Bangkok, same calendar day)', () => {
      const out = formatLocalisedDate('2026-07-30', 'en', { dateStyle: 'medium' });
      expect(out).toContain('30');
    });
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
