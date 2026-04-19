/**
 * T023 — Money value object tests.
 * Coverage target: 100% line + branch (Constitution II, security-critical).
 */
import { describe, expect, it } from 'vitest';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

describe('Money value object', () => {
  describe('construction', () => {
    it('zero()', () => {
      expect(Money.zero().satang).toBe(0n);
    });

    it('ofSatang rejects negative', () => {
      const r = Money.ofSatang(-1n);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('negative_amount');
    });

    it('ofSatang accepts zero + positive', () => {
      expect(Money.ofSatang(0n).ok).toBe(true);
      expect(Money.ofSatang(123n).ok).toBe(true);
    });

    it('fromSatangUnsafe throws on negative', () => {
      expect(() => Money.fromSatangUnsafe(-1)).toThrow();
    });

    it('fromSatangUnsafe accepts number and bigint', () => {
      expect(Money.fromSatangUnsafe(100).satang).toBe(100n);
      expect(Money.fromSatangUnsafe(100n).satang).toBe(100n);
    });

    it('fromTHB converts with half-away rounding', () => {
      expect(Money.fromTHB(1).satang).toBe(100n);
      expect(Money.fromTHB(1.23).satang).toBe(123n);
      expect(Money.fromTHB(1.235).satang).toBe(124n); // .5 rounds up (Math.round)
    });

    it('fromTHB rejects negative', () => {
      expect(() => Money.fromTHB(-1)).toThrow();
    });
  });

  describe('arithmetic', () => {
    it('add', () => {
      expect(Money.fromSatangUnsafe(100).add(Money.fromSatangUnsafe(50)).satang).toBe(150n);
    });

    it('subtract ok when non-negative', () => {
      const r = Money.fromSatangUnsafe(100).subtract(Money.fromSatangUnsafe(30));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.satang).toBe(70n);
    });

    it('subtract fails when result would be negative', () => {
      const r = Money.fromSatangUnsafe(30).subtract(Money.fromSatangUnsafe(100));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('negative_amount');
    });

    it('multiplyByFraction 3/4 on 100 satang = 75 satang', () => {
      expect(Money.fromSatangUnsafe(100).multiplyByFraction(3n, 4n).satang).toBe(75n);
    });

    it('multiplyByFraction rounds half-away-from-zero', () => {
      // 100 × 1/3 = 33.33... → 33
      expect(Money.fromSatangUnsafe(100).multiplyByFraction(1n, 3n).satang).toBe(33n);
      // 100 × 2/3 = 66.67 → 67
      expect(Money.fromSatangUnsafe(100).multiplyByFraction(2n, 3n).satang).toBe(67n);
      // 100 × 1/2 = 50
      expect(Money.fromSatangUnsafe(100).multiplyByFraction(1n, 2n).satang).toBe(50n);
    });

    it('multiplyByFraction rejects denominator 0', () => {
      expect(() => Money.fromSatangUnsafe(100).multiplyByFraction(1n, 0n)).toThrow();
    });

    it('multiplyByDecimal4 "0.7500"', () => {
      expect(Money.fromSatangUnsafe(100).multiplyByDecimal4('0.7500').satang).toBe(75n);
    });

    it('multiplyByDecimal4 "1.0000" identity', () => {
      expect(Money.fromSatangUnsafe(12345n).multiplyByDecimal4('1.0000').satang).toBe(12345n);
    });

    it('multiplyByDecimal4 "0.0000" → zero', () => {
      expect(Money.fromSatangUnsafe(100).multiplyByDecimal4('0.0000').satang).toBe(0n);
    });

    it('multiplyByDecimal4 rejects malformed string', () => {
      expect(() => Money.fromSatangUnsafe(100).multiplyByDecimal4('abc')).toThrow();
    });

    it('multiplyByDecimal4 rejects malformed frac part', () => {
      expect(() => Money.fromSatangUnsafe(100).multiplyByDecimal4('1.2a')).toThrow();
    });

    it('multiplyByDecimal4 rejects negative decimal string', () => {
      expect(() => Money.fromSatangUnsafe(100).multiplyByDecimal4('-1.0000')).toThrow();
    });

    it('multiplyByFraction throws on negative result path (negative numerator)', () => {
      // Hits the `scaled - half` branch in line 85 + negative-check in line 86.
      expect(() => Money.fromSatangUnsafe(100).multiplyByFraction(-1n, 1n)).toThrow();
    });
  });

  describe('comparison + equality', () => {
    it('compare returns -1/0/1', () => {
      const a = Money.fromSatangUnsafe(10);
      const b = Money.fromSatangUnsafe(20);
      expect(a.compare(b)).toBe(-1);
      expect(b.compare(a)).toBe(1);
      expect(a.compare(a)).toBe(0);
    });

    it('equals', () => {
      expect(Money.fromSatangUnsafe(100).equals(Money.fromSatangUnsafe(100))).toBe(true);
      expect(Money.fromSatangUnsafe(100).equals(Money.fromSatangUnsafe(101))).toBe(false);
    });

    it('isZero', () => {
      expect(Money.zero().isZero()).toBe(true);
      expect(Money.fromSatangUnsafe(1).isZero()).toBe(false);
    });
  });

  describe('display', () => {
    it('toTHB', () => {
      expect(Money.fromSatangUnsafe(12345).toTHB()).toBe(123.45);
    });

    it('toString', () => {
      expect(Money.fromSatangUnsafe(12345).toString()).toBe('123.45 THB');
      expect(Money.fromSatangUnsafe(100).toString()).toBe('1.00 THB');
      expect(Money.zero().toString()).toBe('0.00 THB');
    });
  });
});
