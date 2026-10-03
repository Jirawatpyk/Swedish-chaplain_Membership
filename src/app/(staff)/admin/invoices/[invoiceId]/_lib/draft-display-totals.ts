/**
 * Server-side: the invoice detail page's draft totals panel. A draft stores
 * no totals (they are pinned at issue), so the page previews them from the
 * line sum + the tenant's invoice-settings VAT rate through the issue use
 * case's own `computeIssuePricing` — what the admin previews is what issuance
 * will pin (standard treatment; the §80/1(5) zero rate is chosen in the Issue
 * dialog, which gets the per-treatment totals).
 *
 * No settings → no rate to split at. A VAT-inclusive draft's line sum is then
 * its TOTAL (never its subtotal); a VAT-exclusive draft's line sum is its
 * subtotal. Nothing else is guessed — issuing refuses `settings_missing`.
 */
import { computeIssuePricing, type Money, type VatRate } from '@/modules/invoicing';
import type { IssueTotalsByTreatment } from '../../_lib/issue-summary-totals';
import { buildIssueTotalsByTreatment } from './issue-totals-by-treatment';

export interface DraftDisplayTotals {
  readonly subtotalSatang: bigint | null;
  readonly vatSatang: bigint | null;
  readonly totalSatang: bigint | null;
  /** The applied rate in basis points; null without settings. */
  readonly vatRateBps: number | null;
  /** The Issue dialog's per-treatment figures; null without settings. */
  readonly issueTotals: IssueTotalsByTreatment | null;
}

export function draftDisplayTotals(input: {
  readonly lineSum: Money;
  readonly vatInclusive: boolean;
  /** `tenant_invoice_settings.vat_rate`, or null when the tenant has none. */
  readonly standardRate: VatRate | null;
}): DraftDisplayTotals {
  const { lineSum, vatInclusive, standardRate } = input;
  if (standardRate === null) {
    return {
      subtotalSatang: vatInclusive ? null : lineSum.satang,
      vatSatang: null,
      totalSatang: vatInclusive ? lineSum.satang : null,
      vatRateBps: null,
      issueTotals: null,
    };
  }
  const pricing = computeIssuePricing({
    lineSum,
    vatInclusive,
    vatTreatment: 'standard',
    standardRate,
  });
  return {
    subtotalSatang: pricing.subtotal.satang,
    vatSatang: pricing.vat.satang,
    totalSatang: pricing.total.satang,
    vatRateBps: Number(pricing.vatRate.numerator),
    issueTotals: buildIssueTotalsByTreatment({ lineSum, vatInclusive, standardRate }),
  };
}
