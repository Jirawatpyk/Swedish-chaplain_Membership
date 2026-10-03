/**
 * The invoice detail page's draft totals panel. A draft stores no totals, so
 * the page previews them from the line sum + the tenant VAT rate through the
 * issue use case's own policy. With no invoice settings there is no rate to
 * split at: a VAT-inclusive draft's line sum is its TOTAL, never its subtotal.
 */
import { describe, expect, it } from 'vitest';
import { draftDisplayTotals } from '@/app/(staff)/admin/invoices/[invoiceId]/_lib/draft-display-totals';
import { computeIssuePricing } from '@/modules/invoicing/domain/policies/compute-issue-pricing';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

const LINE_SUM = Money.fromSatangUnsafe(1_070_000n);
const STANDARD = VatRate.ofUnsafe('0.0700');

describe('draftDisplayTotals', () => {
  it('no settings, VAT-inclusive: the line sum is the total; no subtotal / VAT is guessed', () => {
    const t = draftDisplayTotals({ lineSum: LINE_SUM, vatInclusive: true, standardRate: null });
    expect(t.subtotalSatang).toBeNull();
    expect(t.vatSatang).toBeNull();
    expect(t.totalSatang).toBe(1_070_000n);
    expect(t.vatRateBps).toBeNull();
    expect(t.issueTotals).toBeNull();
  });

  it('no settings, VAT-exclusive: the line sum is the subtotal (unchanged)', () => {
    const t = draftDisplayTotals({ lineSum: LINE_SUM, vatInclusive: false, standardRate: null });
    expect(t.subtotalSatang).toBe(1_070_000n);
    expect(t.vatSatang).toBeNull();
    expect(t.totalSatang).toBeNull();
    expect(t.vatRateBps).toBeNull();
    expect(t.issueTotals).toBeNull();
  });

  it('with settings: the figures issueInvoice will pin (standard), plus the dialog totals', () => {
    for (const vatInclusive of [true, false]) {
      const t = draftDisplayTotals({ lineSum: LINE_SUM, vatInclusive, standardRate: STANDARD });
      const want = computeIssuePricing({
        lineSum: LINE_SUM,
        vatInclusive,
        vatTreatment: 'standard',
        standardRate: STANDARD,
      });
      expect(t.subtotalSatang).toBe(want.subtotal.satang);
      expect(t.vatSatang).toBe(want.vat.satang);
      expect(t.totalSatang).toBe(want.total.satang);
      expect(t.vatRateBps).toBe(700);
      expect(t.issueTotals?.standard.totalSatang).toBe(Number(want.total.satang));
      expect(t.issueTotals?.zero_rated_80_1_5.vatSatang).toBe(0);
    }
  });
});
