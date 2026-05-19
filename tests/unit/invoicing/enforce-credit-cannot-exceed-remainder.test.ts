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

  /**
   * F5R3v3 M-9 (2026-05-16) — B-1 forensic-escape regression guard.
   *
   * If a data-corruption bug surfaces an invoice where
   * `alreadyCredited > invoiceTotal` (dropped CHECK constraint, OOB
   * SQL admin write, F4 partial-credit accounting bug), the policy
   * MUST construct the err payload WITHOUT throwing. Pre-B-1 the
   * `asSatang(...)` calls inside the err payload would have rejected
   * the negative `remaining` value, escaping the err-branch and
   * propagating as a generic 500 → lost diagnostic at exactly the
   * moment an admin needs the corrupted breakdown for reconciliation.
   *
   * Today's `asSatangUnchecked` preserves the offending values; the
   * `remainingSatang` field is still clamped to 0n by the policy
   * (B-1 left the clamp in place as a separate decision) — the
   * other 3 fields carry the raw values into the audit row.
   */
  it('B-1 forensic guard: err payload constructs when alreadyCredited > invoiceTotal (negative remainder)', () => {
    // Scenario: invoice total = 100 satang, but the running already-
    // credited tally is 200 satang (data corruption). A new credit
    // request for 50 satang fires the over-credit branch.
    const r = enforceCreditCannotExceedRemainder({
      invoiceTotal: Money.fromSatangUnsafe(100n),
      alreadyCredited: Money.fromSatangUnsafe(200n),
      proposed: Money.fromSatangUnsafe(50n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('credit_exceeds_remainder');
      // Forensic values flow through unmodified — the audit row
      // captures the actual corrupted breakdown so admin can trace
      // the source. invoiceTotalSatang=100, alreadyCreditedSatang=200,
      // proposedSatang=50.
      expect(r.error.invoiceTotalSatang).toBe(100n);
      expect(r.error.alreadyCreditedSatang).toBe(200n);
      expect(r.error.proposedSatang).toBe(50n);
      // remainingSatang is clamped to 0n by the policy (was -100n
      // before clamp). This is acceptable because (a) negatives in
      // an UI-facing "remaining" field are nonsensical, (b) the
      // other 3 fields above already preserve enough information
      // for admin reconciliation.
      expect(r.error.remainingSatang).toBe(0n);
    }
  });

  it('B-1 forensic guard: exact-equal alreadyCredited+invoiceTotal corruption still constructs err', () => {
    // Edge case: alreadyCredited === invoiceTotal (= 0 remaining)
    // with any positive proposed → over-credit by exactly the
    // proposed amount.
    const r = enforceCreditCannotExceedRemainder({
      invoiceTotal: Money.fromSatangUnsafe(100n),
      alreadyCredited: Money.fromSatangUnsafe(100n),
      proposed: Money.fromSatangUnsafe(1n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.invoiceTotalSatang).toBe(100n);
      expect(r.error.alreadyCreditedSatang).toBe(100n);
      expect(r.error.proposedSatang).toBe(1n);
      expect(r.error.remainingSatang).toBe(0n);
    }
  });
});
