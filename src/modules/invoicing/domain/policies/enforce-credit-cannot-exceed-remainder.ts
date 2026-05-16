/**
 * T077 — Partial-accumulation invariant (F4 / FR-022).
 *
 * Enforces: sum(existing credit totals) + new credit total ≤ invoice
 * total. The Application layer supplies the lock (`SELECT … FOR UPDATE`
 * on the parent invoice row) so concurrent credit-note issues
 * serialise; this pure policy is the arithmetic invariant alone.
 *
 * Returns ok on legal, err on over-credit.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import { asSatangUnchecked, type Satang } from '@/lib/money';
import type { Money } from '@/modules/invoicing/domain/value-objects/money';

export type CreditRemainderError = {
  readonly kind: 'credit_exceeds_remainder';
  /** Invoice total (satang, incl. VAT). */
  readonly invoiceTotalSatang: Satang;
  /** Sum of prior credit-note totals (satang). */
  readonly alreadyCreditedSatang: Satang;
  /** Proposed new credit-note total (satang). */
  readonly proposedSatang: Satang;
  /** Remaining creditable amount (satang). */
  readonly remainingSatang: Satang;
};

export function enforceCreditCannotExceedRemainder(input: {
  readonly invoiceTotal: Money;
  readonly alreadyCredited: Money;
  readonly proposed: Money;
}): { ok: true } | { ok: false; error: CreditRemainderError } {
  const remaining = input.invoiceTotal.satang - input.alreadyCredited.satang;
  if (input.proposed.satang > remaining) {
    return {
      ok: false,
      error: {
        kind: 'credit_exceeds_remainder',
        // F5R3v2 B-1 (2026-05-16) — `asSatangUnchecked` for error-
        // payload escape: surfacing money imbalance MUST NOT throw on
        // the corrupted values it exists to record. The non-negative
        // clamp on `remainingSatang` (lines below) was already
        // defensive against the legitimate "fully credited" zero
        // case; here we additionally allow corrupted negatives to flow
        // through for diagnostic forensics.
        invoiceTotalSatang: asSatangUnchecked(input.invoiceTotal.satang),
        alreadyCreditedSatang: asSatangUnchecked(input.alreadyCredited.satang),
        proposedSatang: asSatangUnchecked(input.proposed.satang),
        remainingSatang: asSatangUnchecked(remaining < 0n ? 0n : remaining),
      },
    };
  }
  return { ok: true };
}
