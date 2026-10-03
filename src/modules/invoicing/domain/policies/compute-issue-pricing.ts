/**
 * Issue-time pricing (054 Model A vs Model B + 088 US8 `vat_treatment`).
 *
 * The ONE computation `issueInvoice` pins into the immutable snapshot, also
 * used by the staff draft preview and the Issue dialog's summary, so what the
 * admin confirms is what the bill carries (the dialog used to re-derive
 * `calculateVat(lineSum, standard)` and overstated zero-rated and
 * VAT-inclusive event fees).
 *
 *   - The rate is DRIVEN by the treatment (FR-025 / G3): `resolveVatRate`.
 *   - VAT-EXCLUSIVE (membership, vatInclusive=false): the line sum IS the
 *     subtotal; VAT is added on top → `calculateVat`.
 *   - VAT-INCLUSIVE (event Model B, vatInclusive=true): the line sum IS the
 *     total; subtotal + VAT are carved out → `splitVatInclusive`, which keeps
 *     subtotal+vat===total exactly.
 *
 * PURE Domain — no framework/ORM imports (client-bundle safe).
 */
import { calculateVat } from './calculate-vat';
import { resolveVatRate, type VatTreatment } from './vat-treatment';
import type { Money } from '../value-objects/money';
import { splitVatInclusive } from '../value-objects/vat-inclusive';
import type { VatRate } from '../value-objects/vat-rate';

export interface IssuePricingInput {
  /** Sum of the draft's line totals. */
  readonly lineSum: Money;
  readonly vatInclusive: boolean;
  readonly vatTreatment: VatTreatment;
  /** The tenant's configured standard rate (`tenant_invoice_settings`). */
  readonly standardRate: VatRate;
}

export interface IssuePricing {
  readonly subtotal: Money;
  readonly vat: Money;
  readonly total: Money;
  /** The rate actually applied — the issue-time `vatRateSnapshot`. */
  readonly vatRate: VatRate;
}

export function computeIssuePricing(input: IssuePricingInput): IssuePricing {
  const vatRate = resolveVatRate(input.vatTreatment, input.standardRate);
  if (input.vatInclusive) {
    const total = input.lineSum;
    const { subtotal, vat } = splitVatInclusive(total, vatRate.numerator);
    return { subtotal, vat, total, vatRate };
  }
  const { subtotal, vat, total } = calculateVat(input.lineSum, vatRate);
  return { subtotal, vat, total, vatRate };
}
