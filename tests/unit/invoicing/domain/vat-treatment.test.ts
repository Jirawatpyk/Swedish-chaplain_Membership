/**
 * 088-invoice-tax-flow-redesign (T057 / US8 / FR-025 / § F.8.3) — VAT-treatment
 * policy unit tests.
 *
 * `vat_treatment` is the SINGLE SOURCE OF TRUTH that DRIVES the VAT rate (G3):
 * 'zero_rated_80_1_5' → 0%, 'standard' → the tenant's configured rate. The
 * rate is NEVER set independently of the treatment. Plus the ≥5,000-THB
 * advisory-warning threshold (FR-024, non-blocking).
 */
import { describe, expect, it } from 'vitest';
import {
  resolveVatRate,
  isZeroRateBelowThreshold,
  ZERO_RATE_MIN_SUBTOTAL_SATANG,
} from '@/modules/invoicing/domain/policies/vat-treatment';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

describe('resolveVatRate — vat_treatment DRIVES the rate (FR-025 / G3)', () => {
  it("'zero_rated_80_1_5' → 0.0000 regardless of the tenant standard rate", () => {
    const r = resolveVatRate('zero_rated_80_1_5', VatRate.ofUnsafe('0.0700'));
    expect(r.raw).toBe('0.0000');
  });

  it("'zero_rated_80_1_5' → 0.0000 even for a non-7% tenant rate (single source)", () => {
    const r = resolveVatRate('zero_rated_80_1_5', VatRate.ofUnsafe('0.0850'));
    expect(r.raw).toBe('0.0000');
  });

  it("'standard' → the tenant's configured rate verbatim", () => {
    expect(resolveVatRate('standard', VatRate.ofUnsafe('0.0700')).raw).toBe('0.0700');
    expect(resolveVatRate('standard', VatRate.ofUnsafe('0.0850')).raw).toBe('0.0850');
  });
});

describe('isZeroRateBelowThreshold — ≥5,000-THB advisory warn (FR-024, non-blocking)', () => {
  it('threshold is 5,000.00 THB = 500,000 satang', () => {
    expect(ZERO_RATE_MIN_SUBTOTAL_SATANG).toBe(500_000n);
  });

  it('zero-rate + subtotal < 5,000 THB → warn true', () => {
    expect(isZeroRateBelowThreshold('zero_rated_80_1_5', 499_999n)).toBe(true);
    expect(isZeroRateBelowThreshold('zero_rated_80_1_5', 0n)).toBe(true);
  });

  it('zero-rate + subtotal exactly 5,000 THB → NOT below (>= threshold, no warn)', () => {
    expect(isZeroRateBelowThreshold('zero_rated_80_1_5', 500_000n)).toBe(false);
  });

  it('zero-rate + subtotal > 5,000 THB → no warn', () => {
    expect(isZeroRateBelowThreshold('zero_rated_80_1_5', 12_000_00n)).toBe(false);
  });

  it('standard treatment → NEVER warns (threshold only applies to zero-rate)', () => {
    expect(isZeroRateBelowThreshold('standard', 1n)).toBe(false);
    expect(isZeroRateBelowThreshold('standard', 499_999n)).toBe(false);
  });
});
