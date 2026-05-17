/**
 * F4 Domain — CreditNote aggregate unit tests.
 *
 * Covers:
 *   - parseCreditNoteId / asCreditNoteId — branded UUID validators
 *   - assertCreditNoteVatBalance — money invariant
 *     (creditAmount + vat === total) at the repo→domain boundary
 *
 * Source: src/modules/invoicing/domain/credit-note.ts
 *
 * Authored 2026-05-17 (Phase B of F4 Domain coverage push).
 */
import { describe, it, expect } from 'vitest';
import {
  parseCreditNoteId,
  asCreditNoteId,
  assertCreditNoteVatBalance,
} from '@/modules/invoicing/domain/credit-note';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('parseCreditNoteId — validate-and-brand from untrusted input', () => {
  it('returns ok for a canonical lowercase UUID', () => {
    const r = parseCreditNoteId(VALID_UUID);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(VALID_UUID);
    }
  });

  it('returns ok for an uppercase UUID (case-insensitive per RE_UUID)', () => {
    const r = parseCreditNoteId(VALID_UUID.toUpperCase());
    expect(r.ok).toBe(true);
  });

  it('returns ok for a mixed-case UUID', () => {
    const r = parseCreditNoteId('550E8400-e29B-41D4-a716-446655440000');
    expect(r.ok).toBe(true);
  });

  it('returns err for empty string', () => {
    const r = parseCreditNoteId('');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_credit_note_id');
      expect(r.error.raw).toBe('');
    }
  });

  it('returns err for a non-UUID string', () => {
    const r = parseCreditNoteId('not-a-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.raw).toBe('not-a-uuid');
    }
  });

  it('returns err for a truncated UUID', () => {
    const r = parseCreditNoteId(VALID_UUID.slice(0, 30));
    expect(r.ok).toBe(false);
  });

  it('returns err for a non-string (typeof guard)', () => {
    // Caller may pass `undefined` via destructured route params.
    const r = parseCreditNoteId(undefined as unknown as string);
    expect(r.ok).toBe(false);
  });

  it('returns err for null', () => {
    const r = parseCreditNoteId(null as unknown as string);
    expect(r.ok).toBe(false);
  });
});

describe('asCreditNoteId — trusted brand cast', () => {
  it('does NOT validate (trusted contexts only — DB rows, just-generated UUIDs)', () => {
    // Per docstring: trusted brand cast. Use for DB→domain mapping
    // or just-generated UUIDs. Does NOT validate format.
    const cn = asCreditNoteId('any-string-trusted-by-caller');
    expect(cn).toBe('any-string-trusted-by-caller');
  });

  it('preserves a canonical UUID', () => {
    const cn = asCreditNoteId(VALID_UUID);
    expect(cn).toBe(VALID_UUID);
  });
});

describe('assertCreditNoteVatBalance — money invariant (IM-5 review fix)', () => {
  // Build Money objects via the public API; these tests pin the
  // creditAmount + vat === total invariant at the boundary.
  const credit = Money.fromSatangUnsafe(100_000n); // 1000 THB
  const vat = Money.fromSatangUnsafe(7_000n); // 70 THB (7% of 1000)
  const total = Money.fromSatangUnsafe(107_000n); // 1070 THB

  it('returns ok when creditAmount + vat === total', () => {
    const r = assertCreditNoteVatBalance({
      creditAmount: credit,
      vat,
      total,
    });
    expect(r.ok).toBe(true);
  });

  it('returns err with vat_balance_violated when sum mismatches total (off by 1 satang)', () => {
    const r = assertCreditNoteVatBalance({
      creditAmount: credit,
      vat,
      total: Money.fromSatangUnsafe(107_001n), // off by 1 satang
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('vat_balance_violated');
      expect(r.error.creditAmountSatang).toBe(100_000n);
      expect(r.error.vatSatang).toBe(7_000n);
      expect(r.error.totalSatang).toBe(107_001n);
    }
  });

  it('returns err when total too low by larger amount', () => {
    const r = assertCreditNoteVatBalance({
      creditAmount: credit,
      vat,
      total: Money.fromSatangUnsafe(50_000n),
    });
    expect(r.ok).toBe(false);
  });

  it('handles zero-VAT credit note (e.g. tax-exempt) when credit == total', () => {
    const r = assertCreditNoteVatBalance({
      creditAmount: Money.fromSatangUnsafe(100_000n),
      vat: Money.fromSatangUnsafe(0n),
      total: Money.fromSatangUnsafe(100_000n),
    });
    expect(r.ok).toBe(true);
  });

  it('handles zero-amount credit (degenerate, defensive)', () => {
    const zero = Money.fromSatangUnsafe(0n);
    const r = assertCreditNoteVatBalance({
      creditAmount: zero,
      vat: zero,
      total: zero,
    });
    expect(r.ok).toBe(true);
  });

  it('error payload uses asSatangUnchecked (preserves untrusted value for diagnostics)', () => {
    // Per F5R3v2 B-1 comment: asSatangUnchecked bypasses non-negative
    // validation so the diagnostic surfaces actual corrupt values.
    // The error payload should be inspectable.
    const r = assertCreditNoteVatBalance({
      creditAmount: Money.fromSatangUnsafe(10n),
      vat: Money.fromSatangUnsafe(2n),
      total: Money.fromSatangUnsafe(15n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Sum: 12, total: 15 — mismatch by 3.
      expect(r.error.creditAmountSatang + r.error.vatSatang).toBe(12n);
      expect(r.error.totalSatang).toBe(15n);
    }
  });
});
