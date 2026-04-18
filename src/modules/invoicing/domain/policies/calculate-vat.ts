/**
 * T029 — VAT calculation policy (F4).
 *
 * Thai Revenue Department convention (research.md § 6): rounding is
 * performed at the TOTAL level, not per-line. I.e.:
 *
 *   subtotal = sum(line.total_satang for line in lines)   (already integer)
 *   vat      = round(subtotal × vatRate)                    (total-level)
 *   total    = subtotal + vat
 *
 * Rounding: half-away-from-zero. BigInt arithmetic is exact; rounding
 * happens once at the VAT step via the `MoneyDecimal4`-style
 * multiplication helper.
 */
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import type { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

export interface VatCalculationResult {
  readonly subtotal: Money;
  readonly vat: Money;
  readonly total: Money;
}

export function calculateVat(subtotal: Money, vatRate: VatRate): VatCalculationResult {
  // Money.multiplyByFraction rounds half-away-from-zero in satang units,
  // which matches Thai RD total-level rounding convention.
  const vat = subtotal.multiplyByFraction(vatRate.numerator, vatRate.denominator);
  const total = subtotal.add(vat);
  return { subtotal, vat, total };
}
