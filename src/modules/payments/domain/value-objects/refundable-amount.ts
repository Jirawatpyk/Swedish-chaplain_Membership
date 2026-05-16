/**
 * T106 — RefundableAmount value-object (F5 / data-model.md § 3.5).
 *
 * Pure arithmetic policy:
 *
 *     remaining(payment, refunds) = payment.amount_satang
 *                                  − Σ(refund.amount_satang
 *                                       WHERE refund.status='succeeded')
 *
 * The Application use-case (`issue-refund.ts`) calls this AFTER taking
 * a `SELECT … FOR UPDATE` row lock on `payments(id)` so the read of
 * `succeededSumSatang` is a snapshot consistent with the transaction.
 *
 * Pre-flight rejection (FR-011b) is encoded by the companion invariant
 * `refund-not-exceeding-remainder.ts`.
 *
 * Pure TypeScript — no framework/ORM imports.
 *
 * F5R3v2 H-5 (2026-05-16) — branded `Satang` on every input + output.
 * Pre-fix the inputs were raw `bigint` while their caller-site values
 * (`Payment.amountSatang`, `getRefundContextForUpdate.succeededSumSatang`)
 * are already `Satang` after R3 H-5. The downcast was silent. With
 * branded inputs, a caller can't accidentally mix `invoice.totalBaht`
 * (or any other bigint without the brand) into refund arithmetic.
 */
import { asSatang, type Satang } from '@/lib/money';

export interface RefundableAmountInput {
  /** Total settled amount on the Payment (`payments.amount_satang`). */
  readonly paymentAmountSatang: Satang;
  /** Cumulative sum of `refunds.amount_satang WHERE status='succeeded'`. */
  readonly succeededSumSatang: Satang;
}

export interface RefundableAmount {
  readonly remainingSatang: Satang;
  readonly fullyRefunded: boolean;
}

/**
 * Compute the remaining refundable amount.
 *
 * Defensive clamp: if `succeededSumSatang > paymentAmountSatang` the
 * function returns `remainingSatang === 0n` rather than a negative
 * value. A negative remainder is impossible under the FR-011b
 * invariant — but if a future bug or out-of-band manual SQL produces
 * one, callers should treat the payment as fully refunded rather than
 * compounding the inconsistency by reporting "negative refundable".
 *
 * Throws on negative input — both arguments must be non-negative.
 */
export function computeRefundableAmount(
  input: RefundableAmountInput,
): RefundableAmount {
  if (input.paymentAmountSatang < 0n) {
    throw new RangeError(
      `paymentAmountSatang must be ≥ 0; got ${input.paymentAmountSatang}`,
    );
  }
  if (input.succeededSumSatang < 0n) {
    throw new RangeError(
      `succeededSumSatang must be ≥ 0; got ${input.succeededSumSatang}`,
    );
  }
  if (input.succeededSumSatang >= input.paymentAmountSatang) {
    return { remainingSatang: asSatang(0n), fullyRefunded: true };
  }
  // Subtraction guaranteed positive by the gate above; asSatang
  // re-brands the result (Satang minus Satang strips the brand).
  return {
    remainingSatang: asSatang(
      input.paymentAmountSatang - input.succeededSumSatang,
    ),
    fullyRefunded: false,
  };
}
