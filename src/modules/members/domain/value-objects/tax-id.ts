/**
 * Tax ID value object — country-aware validator.
 *
 * Thailand (country='TH'): 13-digit Thai national tax ID with the official
 * weighted-sum checksum (see `thai-tax-id-checksum.ts`). Required by
 * FR-009a for Corporate + Partnership tiers when country='TH'.
 *
 * Other countries: length 1..50, no checksum enforcement (each country's
 * format varies — we collect for the tax invoice, PDPA + GDPR lawful basis).
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { IsoCountryCode } from './iso-country-code';
import { validateThaiTaxIdChecksum } from '../policies/thai-tax-id-checksum';

declare const TaxIdBrand: unique symbol;
export type TaxId = string & { readonly [TaxIdBrand]: true };

export type TaxIdError =
  | { code: 'taxId.empty' }
  | { code: 'taxId.too_long'; maxLength: 50 }
  | { code: 'taxId.th_wrong_format' }
  | { code: 'taxId.th_bad_checksum' };

export function asTaxId(
  raw: string,
  country: IsoCountryCode,
): Result<TaxId, TaxIdError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return err({ code: 'taxId.empty' });
  if (trimmed.length > 50) return err({ code: 'taxId.too_long', maxLength: 50 });

  if (country === ('TH' as IsoCountryCode)) {
    if (!/^\d{13}$/.test(trimmed))
      return err({ code: 'taxId.th_wrong_format' });
    if (!validateThaiTaxIdChecksum(trimmed))
      return err({ code: 'taxId.th_bad_checksum' });
  }

  return ok(trimmed as TaxId);
}
