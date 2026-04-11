import { describe, expect, it } from 'vitest';
import {
  addMoney,
  addVat,
  asMinorUnits,
  asMoney,
  formatMoney,
  InvalidMoneyError,
  isCurrencyCode,
  multiplyMoney,
  subtractMoney,
  SUPPORTED_CURRENCIES,
  type Money,
} from '@/modules/plans/domain/money';

describe('Money domain', () => {
  describe('asMinorUnits invariants', () => {
    it('accepts non-negative integers', () => {
      expect(asMinorUnits(0)).toBe(0);
      expect(asMinorUnits(3_600_000)).toBe(3_600_000);
    });

    it('rejects floats', () => {
      expect(() => asMinorUnits(1.5)).toThrow(InvalidMoneyError);
    });

    it('rejects negatives', () => {
      expect(() => asMinorUnits(-1)).toThrow(InvalidMoneyError);
    });

    it('rejects NaN + Infinity', () => {
      expect(() => asMinorUnits(Number.NaN)).toThrow(InvalidMoneyError);
      expect(() => asMinorUnits(Number.POSITIVE_INFINITY)).toThrow(InvalidMoneyError);
    });

    it('rejects values above the 10 billion ceiling', () => {
      expect(() => asMinorUnits(10_000_000_001)).toThrow(InvalidMoneyError);
    });

    it('rejects non-numbers', () => {
      expect(() => asMinorUnits('100' as unknown as number)).toThrow(InvalidMoneyError);
    });
  });

  describe('asMoney + currency validation', () => {
    it('accepts every supported currency', () => {
      for (const code of SUPPORTED_CURRENCIES) {
        const m = asMoney(100, code);
        expect(m.currency_code).toBe(code);
      }
    });

    it('rejects unknown currency codes', () => {
      expect(() => asMoney(100, 'XYZ')).toThrow(InvalidMoneyError);
    });

    it('isCurrencyCode narrows correctly', () => {
      expect(isCurrencyCode('THB')).toBe(true);
      expect(isCurrencyCode('thb')).toBe(false);
      expect(isCurrencyCode('XYZ')).toBe(false);
    });
  });

  describe('arithmetic', () => {
    const thb = (n: number): Money => asMoney(n, 'THB');

    it('addMoney sums same-currency amounts', () => {
      const total = addMoney(thb(100), thb(50));
      expect(total.amount_minor_units).toBe(150);
      expect(total.currency_code).toBe('THB');
    });

    it('addMoney rejects cross-currency', () => {
      expect(() => addMoney(thb(100), asMoney(50, 'SEK'))).toThrow(InvalidMoneyError);
    });

    it('subtractMoney preserves non-negative invariant', () => {
      expect(() => subtractMoney(thb(50), thb(100))).toThrow(InvalidMoneyError);
    });

    it('multiplyMoney scales correctly', () => {
      expect(multiplyMoney(thb(100), 3).amount_minor_units).toBe(300);
    });

    it('multiplyMoney rejects fractional factor', () => {
      expect(() => multiplyMoney(thb(100), 1.5)).toThrow(InvalidMoneyError);
    });
  });

  describe('addVat', () => {
    it('adds 7% to 36,000 THB (satang math)', () => {
      // 3,600,000 satang × 1.07 = 3,852,000 satang = 38,520.00 THB
      const base = asMoney(3_600_000, 'THB');
      const withVat = addVat(base, 0.07);
      expect(withVat.amount_minor_units).toBe(3_852_000);
    });

    it('rounds half-up to the nearest integer minor-unit', () => {
      // 100 × 1.075 = 107.5 → 108
      const base = asMoney(100, 'THB');
      expect(addVat(base, 0.075).amount_minor_units).toBe(108);
    });

    it('rejects VAT rates outside [0, 1)', () => {
      expect(() => addVat(asMoney(100, 'THB'), -0.1)).toThrow(InvalidMoneyError);
      expect(() => addVat(asMoney(100, 'THB'), 1.0)).toThrow(InvalidMoneyError);
    });

    it('rejects non-number VAT rates', () => {
      expect(() => addVat(asMoney(100, 'THB'), Number.NaN)).toThrow(InvalidMoneyError);
    });
  });

  describe('formatMoney', () => {
    it('formats THB in th-TH locale', () => {
      const out = formatMoney(asMoney(3_600_000, 'THB'), 'th-TH');
      // Contains the THB symbol + 36,000 in some Thai grouping
      expect(out).toMatch(/36[,.\s\u00a0]000/);
    });

    it('formats SEK in sv-SE locale', () => {
      const out = formatMoney(asMoney(2_600_000, 'SEK'), 'sv-SE');
      expect(out).toMatch(/26/);
    });

    it('handles zero-decimal currencies (JPY)', () => {
      // JPY has 0 decimal places — 3,600,000 minor units = 3,600,000 yen
      const out = formatMoney(asMoney(3_600_000, 'JPY'), 'en-US');
      expect(out).toMatch(/3[,.\s\u00a0]600[,.\s\u00a0]000/);
    });
  });
});
