/**
 * Stage-3 importer — unit tests for the two pure coercion gaps
 * (spec § 8: mapping + validation pure functions). The reused F3 value
 * objects (email/phone/tax-id) have their own suites; this pins only the
 * new helpers: the BE-year guard + the country-name→code resolver.
 */
import { describe, expect, it } from 'vitest';

const { isGregorianYear, countryNameToCode, parseGregorianDate, coercePreferredLanguage } =
  await import('@/../scripts/import-members/coerce');

describe('isGregorianYear — Buddhist-Era leak guard (spec § 3.5)', () => {
  it('accepts plausible Gregorian years', () => {
    expect(isGregorianYear(2026)).toBe(true);
    expect(isGregorianYear(1900)).toBe(true);
    expect(isGregorianYear(2400)).toBe(true);
  });

  it('rejects a Buddhist-Era year (2569 BE = 2026 CE) — the off-by-543 trap', () => {
    expect(isGregorianYear(2569)).toBe(false);
  });

  it('rejects out-of-range + non-integer years', () => {
    expect(isGregorianYear(1899)).toBe(false);
    expect(isGregorianYear(2401)).toBe(false);
    expect(isGregorianYear(2026.5)).toBe(false);
    expect(isGregorianYear(Number.NaN)).toBe(false);
  });
});

describe('countryNameToCode — fail-loud country resolver (spec § 2/§3.3)', () => {
  it('resolves an alpha-2 code, case-insensitively', () => {
    const th = countryNameToCode('TH');
    expect(th.ok).toBe(true);
    if (th.ok) expect(th.value).toBe('TH');
    const seLower = countryNameToCode('se');
    expect(seLower.ok).toBe(true);
    if (seLower.ok) expect(seLower.value).toBe('SE');
  });

  it('resolves an English country name', () => {
    const thai = countryNameToCode('Thailand');
    expect(thai.ok).toBe(true);
    if (thai.ok) expect(thai.value).toBe('TH');
    const sweden = countryNameToCode('Sweden');
    expect(sweden.ok).toBe(true);
    if (sweden.ok) expect(sweden.value).toBe('SE');
  });

  it('fails loud (no TH default) on an empty or unresolvable cell', () => {
    for (const raw of ['', '   ', 'Narnia', 'ZZ', '12']) {
      const res = countryNameToCode(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('country.unresolved');
    }
  });
});

describe('parseGregorianDate — date parse + BE-leak guard (spec § 3.5)', () => {
  it('parses an ISO date to a UTC Date', () => {
    const res = parseGregorianDate('2026-01-15');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.getUTCFullYear()).toBe(2026);
      expect(res.value.getUTCMonth()).toBe(0);
      expect(res.value.getUTCDate()).toBe(15);
    }
  });

  it('rejects a Buddhist-Era year (2569-01-15) as date.be_leak', () => {
    const res = parseGregorianDate('2569-01-15');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('date.be_leak');
  });

  it('rejects empty + unparseable', () => {
    expect(parseGregorianDate('').ok).toBe(false);
    const bad = parseGregorianDate('not-a-date');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('date.invalid');
  });
});

describe('coercePreferredLanguage (spec § 2)', () => {
  it('maps en/th/sv case-insensitively', () => {
    expect(coercePreferredLanguage('TH')).toBe('th');
    expect(coercePreferredLanguage(' Sv ')).toBe('sv');
    expect(coercePreferredLanguage('en')).toBe('en');
  });
  it('returns null for empty/absent or unknown (caller applies default — never guesses)', () => {
    expect(coercePreferredLanguage('')).toBeNull();
    expect(coercePreferredLanguage(null)).toBeNull();
    expect(coercePreferredLanguage(undefined)).toBeNull();
    expect(coercePreferredLanguage('fr')).toBeNull();
  });
});
