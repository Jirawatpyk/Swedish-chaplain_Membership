/**
 * T107 — Invariant: a new refund MUST NOT exceed the remaining
 * refundable amount on its Payment (FR-011b).
 *
 *     newRefundSatang ≤ remaining(payment, succeededRefunds)
 *
 * Returns ok or err with the requested + remaining values so callers
 * can render the rejection in a localised UI message ("Maximum
 * refundable: 5,350.00 THB").
 *
 * The Application use-case `issue-refund.ts` invokes this AFTER the
 * `SELECT … FOR UPDATE` row lock so the remainder is consistent with
 * the transaction snapshot.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import {
  computeRefundableAmount,
  type RefundableAmountInput,
} from '../value-objects/refundable-amount';

export type RefundExceedsRemainderError = {
  readonly kind: 'refund_exceeds_remaining';
  readonly requestedSatang: bigint;
  readonly remainingSatang: bigint;
};

export interface RefundNotExceedingRemainderInput extends RefundableAmountInput {
  readonly newRefundSatang: bigint;
}

export function checkRefundNotExceedingRemainder(
  input: RefundNotExceedingRemainderInput,
): { ok: true; remainingSatang: bigint } | { ok: false; error: RefundExceedsRemainderError } {
  if (input.newRefundSatang <= 0n) {
    // Caller bug — zod at the route boundary already rejects this.
    // Surface a typed error so the invariant is total.
    return {
      ok: false,
      error: {
        kind: 'refund_exceeds_remaining',
        requestedSatang: input.newRefundSatang,
        remainingSatang: 0n,
      },
    };
  }
  const { remainingSatang } = computeRefundableAmount(input);
  if (input.newRefundSatang > remainingSatang) {
    return {
      ok: false,
      error: {
        kind: 'refund_exceeds_remaining',
        requestedSatang: input.newRefundSatang,
        remainingSatang,
      },
    };
  }
  return { ok: true, remainingSatang };
}
