/**
 * T077 — Partial-accumulation invariant (FR-022).
 */
import { describe, expect, it } from 'vitest';
import { enforceCreditCannotExceedRemainder } from '@/modules/invoicing/domain/policies/enforce-credit-cannot-exceed-remainder';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

describe('enforceCreditCannotExceedRemainder', () => {
  it('ok when proposed fits exactly into remainder', () => {
    const r = enforceCreditCannotExceedRemainder({
      invoiceTotal: Money.fromSatangUnsafe(5_350_000n),
      alreadyCredited: Money.fromSatangUnsafe(1_070_000n),
      proposed: Money.fromSatangUnsafe(4_280_000n),
    });
    expect(r.ok).toBe(true);
  });

  it('ok when proposed is strictly less than remainder', () => {
    const r = enforceCreditCannotExceedRemainder({
      invoiceTotal: Money.fromSatangUnsafe(5_350_000n),
      alreadyCredited: Money.zero(),
      proposed: Money.fromSatangUnsafe(1_070_000n),
    });
    expect(r.ok).toBe(true);
  });

  it('err when proposed exceeds remainder by 1 satang', () => {
    const r = enforceCreditCannotExceedRemainder({
      invoiceTotal: Money.fromSatangUnsafe(5_350_000n),
      alreadyCredited: Money.fromSatangUnsafe(1_070_000n),
      proposed: Money.fromSatangUnsafe(4_280_001n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('credit_exceeds_remainder');
      expect(r.error.remainingSatang).toBe(4_280_000n);
    }
  });

  it('err when invoice already fully credited', () => {
    const r = enforceCreditCannotExceedRemainder({
      invoiceTotal: Money.fromSatangUnsafe(5_350_000n),
      alreadyCredited: Money.fromSatangUnsafe(5_350_000n),
      proposed: Money.fromSatangUnsafe(1n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.remainingSatang).toBe(0n);
  });
});
