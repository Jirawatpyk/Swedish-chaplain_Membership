/**
 * The issue-time pricing policy — the single computation the `issueInvoice`
 * use case pins and the Issue dialog previews. The dialog used to re-derive
 * the totals as `calculateVat(lineSum, standard)`, which overstated a
 * zero-rated bill (VAT 0) and a VAT-inclusive event draft (total = line sum).
 */
import { describe, expect, it } from 'vitest';
import { computeIssuePricing } from '@/modules/invoicing/domain/policies/compute-issue-pricing';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

const STANDARD = VatRate.ofUnsafe('0.0700');
const LINE_SUM = Money.fromSatangUnsafe(1_000_000n); // 10,000.00 THB

describe('computeIssuePricing', () => {
  it('standard, VAT-exclusive: 7% on top of the line sum', () => {
    const r = computeIssuePricing({
      lineSum: LINE_SUM,
      vatInclusive: false,
      vatTreatment: 'standard',
      standardRate: STANDARD,
    });
    expect(r.subtotal.satang).toBe(1_000_000n);
    expect(r.vat.satang).toBe(70_000n);
    expect(r.total.satang).toBe(1_070_000n);
    expect(r.vatRate.raw).toBe('0.0700');
  });

  it('zero-rated §80/1(5): VAT 0, total = line sum', () => {
    const r = computeIssuePricing({
      lineSum: LINE_SUM,
      vatInclusive: false,
      vatTreatment: 'zero_rated_80_1_5',
      standardRate: STANDARD,
    });
    expect(r.subtotal.satang).toBe(1_000_000n);
    expect(r.vat.satang).toBe(0n);
    expect(r.total.satang).toBe(1_000_000n);
    expect(r.vatRate.raw).toBe('0.0000');
  });

  it('VAT-inclusive, standard: total = line sum, VAT carved out', () => {
    const r = computeIssuePricing({
      lineSum: LINE_SUM,
      vatInclusive: true,
      vatTreatment: 'standard',
      standardRate: STANDARD,
    });
    expect(r.total.satang).toBe(1_000_000n);
    expect(r.subtotal.satang).toBe(934_579n);
    expect(r.vat.satang).toBe(65_421n);
  });

  it('VAT-inclusive, zero-rated: nothing to carve out', () => {
    const r = computeIssuePricing({
      lineSum: LINE_SUM,
      vatInclusive: true,
      vatTreatment: 'zero_rated_80_1_5',
      standardRate: STANDARD,
    });
    expect(r.subtotal.satang).toBe(1_000_000n);
    expect(r.vat.satang).toBe(0n);
    expect(r.total.satang).toBe(1_000_000n);
  });
});
