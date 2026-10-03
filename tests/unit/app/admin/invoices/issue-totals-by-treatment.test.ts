/**
 * The Issue dialog's per-treatment totals are the issue use case's own
 * pricing, carried as plain numbers across the RSC boundary: for any line sum,
 * standard rate and VAT-inclusive flag, each treatment's set equals
 * `computeIssuePricing` exactly, and subtotal + VAT = total.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildIssueTotalsByTreatment } from '@/app/(staff)/admin/invoices/[invoiceId]/_lib/issue-totals-by-treatment';
import { computeIssuePricing } from '@/modules/invoicing/domain/policies/compute-issue-pricing';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

const TREATMENTS = ['standard', 'zero_rated_80_1_5'] as const;

describe('buildIssueTotalsByTreatment', () => {
  it('equals computeIssuePricing for every treatment, and subtotal + VAT = total', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000_000n }), // up to 1,000,000,000.00 THB
        fc.integer({ min: 0, max: 3000 }), // 0.0000 .. 0.3000 (VatRate's range)
        fc.boolean(),
        (lineSumSatang, rateBps, vatInclusive) => {
          const standardRate = VatRate.ofUnsafe((rateBps / 10_000).toFixed(4));
          const lineSum = Money.fromSatangUnsafe(lineSumSatang);
          const byTreatment = buildIssueTotalsByTreatment({ lineSum, vatInclusive, standardRate });
          for (const vatTreatment of TREATMENTS) {
            const want = computeIssuePricing({ lineSum, vatInclusive, vatTreatment, standardRate });
            const got = byTreatment[vatTreatment];
            expect(BigInt(got.subtotalSatang)).toBe(want.subtotal.satang);
            expect(BigInt(got.vatSatang)).toBe(want.vat.satang);
            expect(BigInt(got.totalSatang)).toBe(want.total.satang);
            expect(got.vatPercent).toBe(want.vatRate.toPercentString());
            expect(got.subtotalSatang + got.vatSatang).toBe(got.totalSatang);
          }
          expect(byTreatment.zero_rated_80_1_5.vatSatang).toBe(0);
          expect(byTreatment.zero_rated_80_1_5.totalSatang).toBe(Number(lineSumSatang));
        },
      ),
      { numRuns: 500 },
    );
  });
});
