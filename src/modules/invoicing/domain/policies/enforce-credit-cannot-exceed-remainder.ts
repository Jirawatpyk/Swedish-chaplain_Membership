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
import type { Money } from '@/modules/invoicing/domain/value-objects/money';

export type CreditRemainderError = {
  readonly kind: 'credit_exceeds_remainder';
  /** Invoice total (satang, incl. VAT). */
  readonly invoiceTotalSatang: bigint;
  /** Sum of prior credit-note totals (satang). */
  readonly alreadyCreditedSatang: bigint;
  /** Proposed new credit-note total (satang). */
  readonly proposedSatang: bigint;
  /** Remaining creditable amount (satang). */
  readonly remainingSatang: bigint;
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
        invoiceTotalSatang: input.invoiceTotal.satang,
        alreadyCreditedSatang: input.alreadyCredited.satang,
        proposedSatang: input.proposed.satang,
        remainingSatang: remaining < 0n ? 0n : remaining,
      },
    };
  }
  return { ok: true };
}
