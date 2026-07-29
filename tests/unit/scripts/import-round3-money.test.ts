/**
 * Round-3 importer — satang-exact money guard (scripts/import-round3/money.ts;
 * review finding R3-2).
 *
 * The load-bearing property: a sheet row that PASSES `sheetMoneyErrors` mints
 * BYTE-IDENTICAL vat + total through the real invoicing domain
 * (`Money.fromTHB` → `calculateVat` with the 0.0700 VatRate — the exact code
 * path issueInvoice runs on the `renewalSignal.unitPriceSatang` subtotal).
 * Property-tested with fast-check rather than examples, because the guard's
 * formula `(a*7 + 50) / 100` and the domain's
 * `Money.multiplyByFraction(700n, 10000n)` only coincide when BOTH implement
 * half-away-from-zero — an off-by-one in either direction survives any finite
 * example set that avoids the .5-satang boundary.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';
import {
  sheetMoneyErrors,
  thbToSatang,
  vat7Satang,
} from '@/../scripts/import-round3/money';

const VAT_7 = VatRate.ofUnsafe('0.0700');

/** Realistic satang ceiling (100M THB) — far above any membership fee, far
 *  below the range where float THB round-trips could lose satang precision. */
const MAX_SATANG = 10_000_000_000n;

const arbAmountSatang = fc.bigInt({ min: 0n, max: MAX_SATANG });

describe('thbToSatang — Money.fromTHB parity (reviewer L5)', () => {
  it('property: thbToSatang(x) === Money.fromTHB(x).satang for every satang-representable THB', () => {
    fc.assert(
      fc.property(arbAmountSatang, (satang) => {
        const thb = Number(satang) / 100;
        expect(thbToSatang(thb)).toBe(Money.fromTHB(thb).satang);
      }),
      { numRuns: 500 },
    );
  });

  it('is sign-symmetric (total on negative input; the guard rejects such rows later)', () => {
    expect(thbToSatang(-1234.56)).toBe(-123_456n);
    expect(thbToSatang(0)).toBe(0n);
  });

  it('throws on non-finite input', () => {
    expect(() => thbToSatang(Number.NaN)).toThrow(/non-finite/);
    expect(() => thbToSatang(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

describe('vat7Satang — calculateVat parity (half-away-from-zero at the total level)', () => {
  it('property: vat7Satang(a) === calculateVat(Money(a), 7%).vat.satang', () => {
    fc.assert(
      fc.property(arbAmountSatang, (amountSat) => {
        const { vat, total } = calculateVat(Money.fromSatangUnsafe(amountSat), VAT_7);
        expect(vat7Satang(amountSat)).toBe(vat.satang);
        expect(amountSat + vat7Satang(amountSat)).toBe(total.satang);
      }),
      { numRuns: 500 },
    );
  });

  it('rounds the exact .5-satang boundary AWAY from zero (a×7 ≡ 50 mod 100)', () => {
    // 12,345.50 THB → 1,234,550 satang; ×7% = 86,418.5 satang → 86,419.
    expect(vat7Satang(1_234_550n)).toBe(86_419n);
    // One satang below the boundary truncates down.
    expect(vat7Satang(1_234_549n)).toBe(86_418n);
  });
});

describe('sheetMoneyErrors — the satang-exact guard', () => {
  it('property: a passing row ⇒ the system-minted total === the sheet total (byte-exact)', () => {
    fc.assert(
      fc.property(arbAmountSatang, (amountSat) => {
        const amountThb = Number(amountSat) / 100;
        const vatSat = vat7Satang(amountSat);
        const totalSat = amountSat + vatSat;
        const row = {
          amountThb,
          vatThb: Number(vatSat) / 100,
          totalThb: Number(totalSat) / 100,
        };
        // The consistent row passes…
        expect(sheetMoneyErrors(row)).toEqual([]);
        // …and what issueInvoice will mint from the same Amount cell is
        // byte-identical to the sheet's own Vat/Total cells.
        const { vat, total } = calculateVat(
          Money.fromSatangUnsafe(thbToSatang(amountThb)),
          VAT_7,
        );
        expect(vat.satang).toBe(thbToSatang(row.vatThb));
        expect(total.satang).toBe(thbToSatang(row.totalThb));
      }),
      { numRuns: 500 },
    );
  });

  it('property: perturbing vat OR total by ±1 satang always trips the guard', () => {
    fc.assert(
      fc.property(
        arbAmountSatang,
        fc.constantFrom(-1n, 1n),
        fc.constantFrom('vat', 'total'),
        (amountSat, delta, field) => {
          const vatSat = vat7Satang(amountSat);
          const totalSat = amountSat + vatSat;
          const row =
            field === 'vat'
              ? {
                  amountThb: Number(amountSat) / 100,
                  vatThb: Number(vatSat + delta) / 100,
                  totalThb: Number(totalSat) / 100,
                }
              : {
                  amountThb: Number(amountSat) / 100,
                  vatThb: Number(vatSat) / 100,
                  totalThb: Number(totalSat + delta) / 100,
                };
          // Guard against the vat perturbation going negative (satang -1).
          fc.pre(field !== 'vat' || vatSat + delta >= 0n);
          expect(sheetMoneyErrors(row)).not.toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('flags a 1-satang vat drift the old ±0.5-THB tolerance silently accepted', () => {
    // 16,000.00 THB → vat must be exactly 1,120.00; 1,120.01 was inside the
    // old tolerance window but mints a different §86/4 receipt total.
    expect(
      sheetMoneyErrors({ amountThb: 16_000, vatThb: 1_120.01, totalThb: 17_120.01 }),
    ).toEqual(['money_vat_not_7pct']);
  });

  it('flags a total that is not amount+vat even when vat itself is exact', () => {
    expect(
      sheetMoneyErrors({ amountThb: 16_000, vatThb: 1_120, totalThb: 17_120.01 }),
    ).toEqual(['money_total_mismatch']);
  });

  it('accepts the half-satang boundary row only at the half-away-from-zero value', () => {
    // amount 12,345.50 → vat 864.185 → half-away-from-zero = 864.19.
    expect(
      sheetMoneyErrors({ amountThb: 12_345.5, vatThb: 864.19, totalThb: 13_209.69 }),
    ).toEqual([]);
    expect(
      sheetMoneyErrors({ amountThb: 12_345.5, vatThb: 864.18, totalThb: 13_209.68 }),
    ).toEqual(['money_vat_not_7pct']);
  });
});
