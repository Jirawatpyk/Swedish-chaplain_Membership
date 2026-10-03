/**
 * T077 — VAT policy for credit notes (F4 / FR-021): cumulative proportional.
 *
 * Given a user-entered `creditTotal` (gross amount to credit, inclusive of
 * VAT) against an original invoice `(originalVat, originalTotal)`, and what
 * the invoice's earlier credit notes already credited `(alreadyCredited,
 * priorCreditedVat)`, split the gross into (creditAmount, vat):
 *
 *   target = round(originalVat × (alreadyCredited + creditTotal) / originalTotal)
 *   vat    = clamp(target − priorCreditedVat, 0, creditTotal − 1)
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
 * Why cumulative: rounding each note on its own let the VAT credited over N
 * partials drift by up to ~N/2 satang — three partials of a 1,070.00 THB
 * invoice credited 70.01 THB of VAT, more output VAT reduced than was ever
 * charged. Rounding the running total instead keeps:
 *   - every running sum ≤ originalVat (target never passes it);
 *   - a fully credited invoice at EXACTLY originalVat (target = originalVat);
 *   - every note within 1 satang of its own proportional VAT, for any N.
 * Legacy notes issued before this rule may have over-credited; the target
 * then sits below what was credited and later notes credit 0 VAT until it
 * catches up.
 *
 * Why `≤ creditTotal − 1`: `credit_notes.credit_amount_satang > 0` (migration
 * 0019). A tiny note whose share of the running target would swallow its
 * whole gross keeps 1 satang of net instead; the satang of VAT it leaves is
 * picked up by a later note (or, on the completing note, stays uncredited —
 * the conservative direction, less output VAT reduced than charged).
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

  // The VAT the running total should have credited after this note, less
  // what earlier notes credited. Negative after legacy over-credit → 0.
  const target = originalVat.multiplyByFraction(
    alreadyCredited.satang + creditTotal.satang,
    originalTotal.satang,
  );
  const share = target.subtract(priorCreditedVat);
  let vat = share.ok ? share.value : Money.zero();
  // Keep at least 1 satang of net (credit_amount_satang > 0).
  const maxVat = creditTotal.subtract(Money.fromSatangUnsafe(1n));
  const cap = maxVat.ok ? maxVat.value : Money.zero();
  if (vat.compare(cap) > 0) vat = cap;

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
