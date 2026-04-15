/**
 * ISO 3166-1 alpha-2 country-code value object.
 *
 * Validates via `i18n-iso-countries` (Infrastructure-free — the package is
 * pure data). We expose a branded `IsoCountryCode` type so arbitrary
 * 2-letter strings cannot masquerade as validated codes.
 *
 * Localized display names live in the Presentation layer via
 * `i18n-iso-countries`'s per-locale data files; Domain only cares about
 * the code itself.
 */
import i18nIsoCountries from 'i18n-iso-countries';
import { err, ok, type Result } from '@/lib/result';

declare const IsoCountryCodeBrand: unique symbol;
export type IsoCountryCode = string & { readonly [IsoCountryCodeBrand]: true };

export type IsoCountryCodeError =
  | { code: 'country.invalid' }
  | { code: 'country.wrong_length' };

export function asIsoCountryCode(
  raw: string,
): Result<IsoCountryCode, IsoCountryCodeError> {
  const upper = raw.trim().toUpperCase();
  if (upper.length !== 2) return err({ code: 'country.wrong_length' });
  if (!i18nIsoCountries.isValid(upper)) return err({ code: 'country.invalid' });
  return ok(upper as IsoCountryCode);
}

export function isIsoCountryCode(value: unknown): value is IsoCountryCode {
  return typeof value === 'string' && asIsoCountryCode(value).ok;
}
