/**
 * Tax ID value object — country-aware validator.
 *
 * Thailand (country='TH'): 13-digit Thai national tax ID with the official
 * weighted-sum checksum (see `thai-tax-id-checksum.ts`). This validator only
 * runs when a tax_id VALUE is supplied — tax_id itself is OPTIONAL by tier.
 * The original FR-009a "required for Corporate + Partnership" rule was
 * superseded by an accepted product decision (a §86/4 buyer-TIN is only needed
 * for VAT-registrant buyers, so members may be saved without one; UAT
 * TC-MBR-04 documents this). When a TH value IS provided, the 13-digit format
 * + checksum are enforced.
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
