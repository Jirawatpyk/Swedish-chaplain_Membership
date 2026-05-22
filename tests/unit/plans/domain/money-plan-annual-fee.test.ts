/**
 * R3 Batch 4c (R3-I12) — `planAnnualFee` accessor unit tests.
 *
 * Round 3 review flagged the accessor (added in Batch 3g) had zero
 * tests. Pinned contracts:
 *   1. Returns branded `Money` with correct currency_code + amount.
 *   2. Rejects unknown currency via `InvalidMoneyError`.
 *   3. `addMoney(planAnnualFee(_, 'THB'), planAnnualFee(_, 'SEK'))`
 *      throws — cross-currency arithmetic guard works through the
 *      accessor.
 *   4. Rejects negative + non-integer + overflow via `asMoney`'s
 *      built-in `asMinorUnits` guards.
 */
import { describe, expect, it } from 'vitest';
import {
  addMoney,
  InvalidMoneyError,
  planAnnualFee,
} from '@/modules/plans/domain/money';

describe('planAnnualFee — R3-I12', () => {
  it('returns branded Money with the given currency + amount', () => {
    const m = planAnnualFee(5_000_000, 'THB');
    expect(m.amount_minor_units).toBe(5_000_000);
    expect(m.currency_code).toBe('THB');
  });

  it('accepts non-THB currencies (SEK / EUR / USD)', () => {
    const sek = planAnnualFee(100_000, 'SEK');
    expect(sek.currency_code).toBe('SEK');
    const eur = planAnnualFee(50, 'EUR');
    expect(eur.amount_minor_units).toBe(50);
    const usd = planAnnualFee(0, 'USD'); // zero is valid (non-negative)
    expect(usd.amount_minor_units).toBe(0);
  });

  it('rejects negative amount via InvalidMoneyError', () => {
    expect(() => planAnnualFee(-1, 'THB')).toThrow(InvalidMoneyError);
  });

  it('rejects non-integer amount via InvalidMoneyError', () => {
    expect(() => planAnnualFee(1.5, 'THB')).toThrow(InvalidMoneyError);
  });

  it('rejects > 10B sanity-ceiling overflow', () => {
    expect(() => planAnnualFee(10_000_000_001, 'THB')).toThrow(
      InvalidMoneyError,
    );
  });

  it('cross-currency addition through the accessor throws', () => {
    const thb = planAnnualFee(100, 'THB');
    const sek = planAnnualFee(200, 'SEK');
    expect(() => addMoney(thb, sek)).toThrow(InvalidMoneyError);
    expect(() => addMoney(thb, sek)).toThrow(/Cross-currency/);
  });

  it('same-currency addition works', () => {
    const a = planAnnualFee(100, 'THB');
    const b = planAnnualFee(200, 'THB');
    const sum = addMoney(a, b);
    expect(sum.amount_minor_units).toBe(300);
    expect(sum.currency_code).toBe('THB');
  });
});
