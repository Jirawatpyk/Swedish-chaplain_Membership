/**
 * T077 — VAT policy for credit notes (F4 / FR-021), with the residual rule.
 *
 * Given a user-entered `creditTotal` (gross amount to credit, inclusive of
 * VAT) against an original invoice `(originalVat, originalTotal)`, and what
 * the invoice's earlier credit notes already credited `(alreadyCredited,
 * priorCreditedVat)`, split the gross into (creditAmount, vat):
 *
 *   remainingVat = max(0, originalVat − priorCreditedVat)
 *   completing   = alreadyCredited + creditTotal == originalTotal
 *
 *   vat = completing ? remainingVat
 *                    : min(round(originalVat × creditTotal / originalTotal), remainingVat)
 *   vat = min(vat, creditTotal)
 *   creditAmount = creditTotal − vat
 *
 * Rounding: half-away-from-zero, via `Money.multiplyByFraction` — same
 * convention as `calculate-vat.ts`, so a single full-amount credit note
 * reproduces the invoice's own VAT exactly.
 *
 * Why proportional (not `creditTotal × vatRate / (1 + vatRate)`): it
 * reproduces the invoice VAT exactly on a full credit, where a
 * recompute-from-rate scheme can drift by ±1 satang because the invoice's
 * VAT was rounded once at issue time.
 *
 * Why the residual rule: rounding each partial note on its own lets the VAT
 * credited over N partials drift by up to ~N/2 satang — three partials of a
 * 1,070.00 THB invoice credited 70.01 THB of VAT, more output VAT reduced
 * than was ever charged. The note that completes the credit therefore takes
 * exactly what is left, and a partial is capped at what is left, so the
 * running total never passes the VAT charged and a fully credited invoice
 * credits it exactly. Legacy notes issued before this rule may already have
 * over-credited; then `remainingVat` is 0 and later notes credit no VAT.
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
  /** Gross already credited by the invoice's earlier credit notes. */
  readonly alreadyCredited: Money;
  /** VAT already credited by those notes (the sum of their `vat`). */
  readonly priorCreditedVat: Money;
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
  const { creditTotal, originalVat, originalTotal, alreadyCredited, priorCreditedVat } = input;
  const exceeds = {
    ok: false as const,
    error: {
      kind: 'credit_exceeds_original' as const,
      creditTotalSatang: creditTotal.satang,
      originalTotalSatang: originalTotal.satang,
    },
  };

  if (originalTotal.isZero()) {
    return { ok: false, error: { kind: 'zero_original_total' } };
  }
  const remainingTotal = originalTotal.subtract(alreadyCredited);
  if (!remainingTotal.ok || creditTotal.compare(remainingTotal.value) > 0) {
    return exceeds;
  }

  // What the earlier notes left of the VAT charged; 0 if legacy notes
  // already credited it all (or more).
  const leftVat = originalVat.subtract(priorCreditedVat);
  const remainingVat = leftVat.ok ? leftVat.value : Money.zero();

  let vat: Money;
  if (creditTotal.equals(remainingTotal.value)) {
    // The completing note takes the residual, so the notes credit exactly
    // the VAT charged.
    vat = remainingVat;
  } else {
    // Proportional: originalVat × (creditTotal / originalTotal), capped so
    // the running total never passes the VAT charged.
    const proportional = originalVat.multiplyByFraction(creditTotal.satang, originalTotal.satang);
    vat = proportional.compare(remainingVat) > 0 ? remainingVat : proportional;
  }
  // A note's VAT can never exceed its own gross (net ≥ 0).
  if (vat.compare(creditTotal) > 0) vat = creditTotal;

  const creditAmountResult = creditTotal.subtract(vat);
  // Unreachable after the clamp above; guarded so a degenerate input still
  // surfaces as a typed error.
  if (!creditAmountResult.ok) return exceeds;

  return {
    ok: true,
    value: {
      creditAmount: creditAmountResult.value,
      vat,
      total: creditTotal,
    },
  };
}
