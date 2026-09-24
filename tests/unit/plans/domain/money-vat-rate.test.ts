/**
 * VAT helpers shared by the plans list and plan detail pages.
 *
 * `grossWithVatMinorUnits` is the integer-only gross the plans list has always
 * computed inline (N2, review 2026-04-19): fee × (10000 + rate) / 10000 with
 * half-up rounding in bigint, where the rate comes from
 * `tenant_invoice_settings.vat_rate` as a 4-dp decimal string ("0.0700").
 * The detail page now shows the same total, so the math lives in one place.
 */
import { describe, expect, it } from 'vitest';
import {
  grossWithVatMinorUnits,
  InvalidMoneyError,
  vatRatePercent,
} from '@/modules/plans/domain/money';

describe('grossWithVatMinorUnits', () => {
  it('adds 7 % VAT to 36,000.00 THB → 38,520.00 THB', () => {
    expect(grossWithVatMinorUnits(3_600_000, '0.0700')).toBe(3_852_000);
  });

  it('rounds half-up in integer math (8.5 % on 1,234,567 satang = 1,339,505)', () => {
    expect(grossWithVatMinorUnits(1_234_567, '0.0850')).toBe(1_339_505);
  });

  it('treats a rate with fewer than 4 decimals by its value, not its digits', () => {
    // "0.07" must mean 7 %, not 0.07 % (the old inline parse read the
    // fraction digits as a count of basis-point-hundredths).
    expect(grossWithVatMinorUnits(3_600_000, '0.07')).toBe(3_852_000);
  });

  it('returns the fee unchanged for a zero rate', () => {
    expect(grossWithVatMinorUnits(3_600_000, '0.0000')).toBe(3_600_000);
    expect(grossWithVatMinorUnits(3_600_000, '0')).toBe(3_600_000);
  });

  it('rounds an exact .5 satang up (half-up, not banker\'s)', () => {
    // 50 × 1.01 = 50.5 → 51 (banker's rounding would give 50)
    expect(grossWithVatMinorUnits(50, '0.0100')).toBe(51);
  });

  it('handles the edges: a zero fee and the 30 % ceiling F4 allows', () => {
    expect(grossWithVatMinorUnits(0, '0.0700')).toBe(0);
    expect(grossWithVatMinorUnits(1_000_000, '0.3000')).toBe(1_300_000);
  });

  it.each(['', 'abc', '-0.07', '0.07000', '7%', '1.5'])(
    'rejects a malformed or out-of-range rate %j',
    (raw) => {
      expect(() => grossWithVatMinorUnits(100, raw)).toThrow(InvalidMoneyError);
    },
  );

  it('rejects a non-integer or negative fee', () => {
    expect(() => grossWithVatMinorUnits(1.5, '0.0700')).toThrow(InvalidMoneyError);
    expect(() => grossWithVatMinorUnits(-1, '0.0700')).toThrow(InvalidMoneyError);
    expect(() => grossWithVatMinorUnits(10_000_000_001, '0.0700')).toThrow(InvalidMoneyError);
  });
});

describe('vatRatePercent', () => {
  it('reads "0.0700" as 7 and "0.0850" as 8.5', () => {
    expect(vatRatePercent('0.0700')).toBe(7);
    expect(vatRatePercent('0.0850')).toBe(8.5);
  });

  it('rejects a malformed rate', () => {
    expect(() => vatRatePercent('seven')).toThrow(InvalidMoneyError);
  });
});
