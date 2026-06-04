import { describe, it, expect } from 'vitest';
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
});
