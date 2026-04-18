import { describe, expect, it } from 'vitest';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

describe('VatRate', () => {
  it('accepts 0.0700 (Thai standard)', () => {
    const r = VatRate.of('0.0700');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.raw).toBe('0.0700');
  });

  it('accepts 0.0000 (zero-rated)', () => {
    expect(VatRate.of('0.0000').ok).toBe(true);
  });

  it('accepts upper bound 0.3000', () => {
    expect(VatRate.of('0.3000').ok).toBe(true);
  });

  it('rejects > 0.3000', () => {
    const r = VatRate.of('0.3001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('out_of_range');
  });

  it('rejects non-4dp strings', () => {
    expect(VatRate.of('0.07').ok).toBe(false);
    expect(VatRate.of('0').ok).toBe(false);
    expect(VatRate.of('abc').ok).toBe(false);
    expect(VatRate.of('-0.0700').ok).toBe(false);
  });

  it('numerator/denominator for fraction math', () => {
    const r = VatRate.ofUnsafe('0.0700');
    expect(r.numerator).toBe(700n);
    expect(r.denominator).toBe(10_000n);
  });

  it('toPercentString', () => {
    expect(VatRate.ofUnsafe('0.0700').toPercentString()).toBe('7.00%');
    expect(VatRate.ofUnsafe('0.0000').toPercentString()).toBe('0.00%');
  });

  it('equals', () => {
    expect(VatRate.ofUnsafe('0.0700').equals(VatRate.ofUnsafe('0.0700'))).toBe(true);
    expect(VatRate.ofUnsafe('0.0700').equals(VatRate.ofUnsafe('0.1000'))).toBe(false);
  });

  it('ofUnsafe throws on malformed', () => {
    expect(() => VatRate.ofUnsafe('abc')).toThrow();
  });
});
