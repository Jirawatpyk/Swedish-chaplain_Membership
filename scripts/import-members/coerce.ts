/**
 * Stage-3 member importer — pure field-coercion helpers.
 *
 * These are the two pieces the F3 value-object library does NOT already
 * provide (everything else — email / phone(E.164) / tax-id(Thai checksum) /
 * iso-country-code — is reused directly from
 * `@/modules/members/domain/value-objects/*`). Pure + framework-free so they
 * unit-test without a DB (spec § 8). See docs/member-import-spec.md.
 */
import i18nIsoCountries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';
import { err, type Result } from '@/lib/result';
import {
  asIsoCountryCode,
  type IsoCountryCode,
} from '@/modules/members/domain/value-objects/iso-country-code';

// `getAlpha2Code(name, 'en')` requires the 'en' locale data registered first;
// `isValid`/`asIsoCountryCode` (code validation) is locale-independent. Register
// once per process (idempotent guard — registerLocale is not safe to call twice).
let enRegistered = false;
function ensureEnLocale(): void {
  if (!enRegistered) {
    i18nIsoCountries.registerLocale(enLocale);
    enRegistered = true;
  }
}

/**
 * Buddhist-Era leak guard (spec § 3 rule 5 + CLAUDE.md off-by-543 ship blocker).
 * A Gregorian year MUST fall in [1900, 2400]. A year > 2400 is almost certainly a
 * Buddhist-Era value (CE + 543) entered by mistake — e.g. 2569 BE = 2026 CE. We
 * reject rather than silently subtract 543, because we cannot be sure the cell is
 * BE vs a typo, and a wrong registration year corrupts F8 renewal math.
 */
export function isGregorianYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1900 && year <= 2400;
}

export type CountryResolveError = {
  readonly code: 'country.unresolved';
  readonly raw: string;
};

/**
 * Resolve an Excel country cell — either an ISO 3166-1 alpha-2 code (`"TH"`,
 * `"se"`) OR an English country name (`"Thailand"`, `"Sweden"`) — to a validated
 * `IsoCountryCode`. **Fail-loud**: no silent `TH` default (operator decision
 * 2026-06-02). An unresolved cell is a per-row validation error so the operator
 * fixes the column/data before `--commit`.
 */
export function countryNameToCode(
  raw: string,
): Result<IsoCountryCode, CountryResolveError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return err({ code: 'country.unresolved', raw });

  // 1. Already a valid alpha-2 code? (case-insensitive — Excel may have "th")
  const asCode = asIsoCountryCode(trimmed.toUpperCase());
  if (asCode.ok) return asCode;

  // 2. English country name → alpha-2.
  ensureEnLocale();
  const code = i18nIsoCountries.getAlpha2Code(trimmed, 'en');
  if (code) {
    const validated = asIsoCountryCode(code);
    if (validated.ok) return validated;
  }

  return err({ code: 'country.unresolved', raw });
}
