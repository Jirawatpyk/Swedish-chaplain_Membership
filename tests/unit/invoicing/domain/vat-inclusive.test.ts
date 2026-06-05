import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { splitVatInclusive } from '@/modules/invoicing/domain/value-objects/vat-inclusive';

describe('splitVatInclusive (half-away, reuses Money)', () => {
  it('AS-VAT-01: 1070 THB incl @7% → subtotal 1000.00, vat 70.00', () => {
    const { subtotal, vat } = splitVatInclusive(Money.fromSatangUnsafe(107_000n), 700n);
    expect(subtotal.satang).toBe(100_000n);
    expect(vat.satang).toBe(7_000n);
  });

  it('invariant: subtotal + vat === total for all totals (fast-check)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10_000_000_00n }), (totalSatang) => {
        const total = Money.fromSatangUnsafe(totalSatang);
        const { subtotal, vat } = splitVatInclusive(total, 700n);
        expect(subtotal.add(vat).satang).toBe(total.satang);
      }),
    );
  });

  it('boundary satang (107, 214, 321) reconcile exactly', () => {
    for (const t of [107n, 214n, 321n]) {
      const { subtotal, vat } = splitVatInclusive(Money.fromSatangUnsafe(t), 700n);
      expect(subtotal.add(vat).satang).toBe(t);
    }
  });

  it('AS-VAT-02: 0% rate → vat=0, subtotal=total', () => {
    const total = Money.fromSatangUnsafe(107_000n);
    const { subtotal, vat } = splitVatInclusive(total, 0n);
    expect(vat.satang).toBe(0n);
    expect(subtotal.satang).toBe(total.satang);
  });

  // speckit-review hardening (FIX C) — close the two defensive throw branches.
  describe('throw branches (programming-error guards)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects a NEGATIVE rateBps (the documented precondition guard at :17)', () => {
      const total = Money.fromSatangUnsafe(107_000n);
      // The fast-check property only spans non-negative rates, so this real,
      // reachable branch (`rateBps < 0n → throw`) was previously uncovered.
      expect(() => splitVatInclusive(total, -1n)).toThrow(
        'splitVatInclusive: rateBps must be >= 0',
      );
      expect(() => splitVatInclusive(total, -700n)).toThrow(/rateBps must be >= 0/);
    });

    it('throws "subtotal exceeds total" if the subtotal ever exceeds the total (defensive guard at :20)', () => {
      // This branch is UNREACHABLE through the public API by construction: with
      // rateBps >= 0 the fraction numerator (10_000) <= denominator
      // (10_000 + rateBps), so `multiplyByFraction` always yields
      // subtotal <= total and `total.subtract(subtotal)` is always ok. The
      // guard exists purely as defence-in-depth against a future regression in
      // Money's rounding. We force it by stubbing `multiplyByFraction` to return
      // a value LARGER than the total — proving the guard fires (and does not
      // silently produce a negative VAT) rather than leaving the line uncovered.
      const total = Money.fromSatangUnsafe(107_000n);
      vi.spyOn(Money.prototype, 'multiplyByFraction').mockReturnValue(
        Money.fromSatangUnsafe(total.satang + 1n),
      );
      expect(() => splitVatInclusive(total, 700n)).toThrow(
        'splitVatInclusive: subtotal exceeds total',
      );
    });
  });
});
