import { describe, expect, it } from 'vitest';
import { calculateVat } from '@/modules/invoicing/domain/policies/calculate-vat';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

describe('calculateVat (total-level rounding)', () => {
  it('1000.00 THB at 7% → 70.00 VAT, 1070.00 total', () => {
    const r = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0700'));
    expect(r.subtotal.toString()).toBe('1000.00 THB');
    expect(r.vat.toString()).toBe('70.00 THB');
    expect(r.total.toString()).toBe('1070.00 THB');
  });

  it('rounding — 123.45 × 7% = 8.6415 → 8.64 (half-away-from-zero)', () => {
    const r = calculateVat(Money.fromTHB(123.45), VatRate.ofUnsafe('0.0700'));
    // 12345 × 700 / 10000 = 864.15 → 864 satang = 8.64 THB
    expect(r.vat.satang).toBe(864n);
  });

  it('zero-rated (0.0000) yields 0 VAT', () => {
    const r = calculateVat(Money.fromTHB(1000), VatRate.ofUnsafe('0.0000'));
    expect(r.vat.isZero()).toBe(true);
    expect(r.total.equals(r.subtotal)).toBe(true);
  });

  it('total-level rounding differs from sum-of-per-line rounding', () => {
    // Hypothetical: 3 lines each 33.33 THB at 7% VAT.
    // Per-line VAT would be 33.33 × 0.07 = 2.3331 → 2.33 per line → 6.99 total
    // Total-level: subtotal = 99.99 × 0.07 = 6.9993 → 7.00.
    const subtotal = Money.fromTHB(99.99);
    const r = calculateVat(subtotal, VatRate.ofUnsafe('0.0700'));
    // 9999 × 700 / 10000 = 699.93 → 700 satang
    expect(r.vat.satang).toBe(700n);
  });
});
