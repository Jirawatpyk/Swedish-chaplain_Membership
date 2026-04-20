/**
 * T077 — Proportional VAT policy for credit notes (F4 / FR-021).
 *
 * Given a user-entered `creditTotal` (gross amount to credit, inclusive of
 * VAT) against an original invoice `(originalSubtotal, originalVat,
 * originalTotal)`, split the gross into (creditAmount, vat) such that:
 *
 *   vat         = round(originalVat × creditTotal / originalTotal)
 *   creditAmount = creditTotal − vat
 *
 * Rounding: half-away-from-zero, via `Money.multiplyByFraction` — same
 * convention as `calculate-vat.ts`, so a full-amount credit note
 * (creditTotal == originalTotal) reproduces the invoice's own VAT
 * exactly, byte-for-byte.
 *
 * Why proportional (not `creditTotal × vatRate / (1 + vatRate)`):
 *
 *  (a) Reproduces the original VAT exactly on a full credit. A
 *      recompute-from-rate scheme can drift by ±1 satang because the
 *      invoice's VAT was rounded once at issue time.
 *  (b) The property test T076 asserts `sum(cn-vats) ≤ originalVat + 1`:
 *      proportional split guarantees ≤ + 1 satang cumulative drift
 *      across any partition, because each partition's rounding error
 *      is bounded by ½ satang and never compounds multiplicatively.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import { Money } from '@/modules/invoicing/domain/value-objects/money';

export interface CreditNoteVatInput {
  /** User-entered gross amount to credit (incl. VAT). */
  readonly creditTotal: Money;
  /** Original invoice VAT (satang), snapshotted at issue time. */
  readonly originalVat: Money;
  /** Original invoice TOTAL (satang, incl. VAT). Must be > 0. */
  readonly originalTotal: Money;
}

export interface CreditNoteVatResult {
  readonly creditAmount: Money; // subtotal portion of the credit
  readonly vat: Money;
  readonly total: Money; // === creditTotal (by definition)
}

export type CreditNoteVatError =
  | { kind: 'zero_original_total' }
  | { kind: 'credit_exceeds_original'; creditTotalSatang: bigint; originalTotalSatang: bigint };

export function calculateCreditNoteVat(
  input: CreditNoteVatInput,
): { ok: true; value: CreditNoteVatResult } | { ok: false; error: CreditNoteVatError } {
  const { creditTotal, originalVat, originalTotal } = input;

  if (originalTotal.isZero()) {
    return { ok: false, error: { kind: 'zero_original_total' } };
  }
  if (creditTotal.compare(originalTotal) > 0) {
    return {
      ok: false,
      error: {
        kind: 'credit_exceeds_original',
        creditTotalSatang: creditTotal.satang,
        originalTotalSatang: originalTotal.satang,
      },
    };
  }

  // Proportional VAT: originalVat × (creditTotal / originalTotal).
  // Money.multiplyByFraction: scaled-integer math, half-away-from-zero.
  const vat = originalVat.multiplyByFraction(creditTotal.satang, originalTotal.satang);

  // creditAmount = creditTotal − vat. Guaranteed ≥ 0 because vat ≤
  // originalVat ≤ originalTotal and creditTotal ≥ vat whenever
  // originalSubtotal ≥ 0 (a vat-only credit is not a legal document).
  const creditAmountResult = creditTotal.subtract(vat);
  // Subtract can only err on underflow; the algebra above bounds vat ≤
  // creditTotal because originalVat ≤ originalTotal. But we guard
  // defensively so a degenerate input surfaces cleanly.
  if (!creditAmountResult.ok) {
    // Should be unreachable for valid inputs; fold into a generic error
    // so the caller's Result type stays uniform.
    return {
      ok: false,
      error: {
        kind: 'credit_exceeds_original',
        creditTotalSatang: creditTotal.satang,
        originalTotalSatang: originalTotal.satang,
      },
    };
  }

  return {
    ok: true,
    value: {
      creditAmount: creditAmountResult.value,
      vat,
      total: creditTotal,
    },
  };
}
