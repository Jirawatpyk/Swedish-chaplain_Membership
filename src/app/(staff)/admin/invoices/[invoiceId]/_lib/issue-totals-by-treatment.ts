/**
 * Server-side: price a draft for each VAT treatment the Issue dialog offers,
 * with the issue use case's own `computeIssuePricing` (treatment-driven rate +
 * VAT-inclusive carve-out). The dialog picks the set for the chosen treatment,
 * so its summary and confirm name what `issueInvoice` will pin.
 */
import { computeIssuePricing, type Money, type VatRate } from '@/modules/invoicing';
import type { VatTreatmentChoice } from '../../_lib/issue-vat-treatment';
import type { IssueTotals, IssueTotalsByTreatment } from '../../_lib/issue-summary-totals';

export function buildIssueTotalsByTreatment(input: {
  readonly lineSum: Money;
  readonly vatInclusive: boolean;
  readonly standardRate: VatRate;
}): IssueTotalsByTreatment {
  const priceFor = (vatTreatment: VatTreatmentChoice): IssueTotals => {
    const p = computeIssuePricing({ ...input, vatTreatment });
    return {
      subtotalSatang: Number(p.subtotal.satang),
      vatSatang: Number(p.vat.satang),
      totalSatang: Number(p.total.satang),
      vatPercent: p.vatRate.toPercentString(),
    };
  };
  return {
    standard: priceFor('standard'),
    zero_rated_80_1_5: priceFor('zero_rated_80_1_5'),
  };
}
