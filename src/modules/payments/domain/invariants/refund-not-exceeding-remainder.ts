/**
 * T107 — Invariant: a new refund MUST NOT exceed the remaining
 * refundable amount on its Payment (FR-011b).
 *
 *     newRefundSatang ≤ remaining(payment, succeededRefunds)
 *
 * B.1 (#4) — the remaining is additionally capped by the INVOICE's
 * un-credited headroom when the F4 bounds are supplied:
 *
 *     remaining = min(
 *       payment.amountSatang − Σ(F5 succeeded refunds),   // payment-based
 *       invoice.totalSatang − invoice.creditedTotalSatang, // invoice-credit-based
 *     )
 *
 * Without the invoice cap, an F5 refund that clears the payment-based
 * limit but exceeds what F4 will accept as a credit note (F4 rejects an
 * over-credit) moves money at Stripe that then orphans with no CN. The
 * invoice bounds are OPTIONAL: omitting them preserves the payment-only
 * cap (backward-compatible with every pre-B.1 caller).
 *
 * Returns ok or err with the requested + remaining values so callers
 * can render the rejection in a localised UI message ("Maximum
 * refundable: 5,350.00 THB").
 *
 * The Application use-case `issue-refund.ts` invokes this AFTER the
 * `SELECT … FOR UPDATE` row lock so the remainder is consistent with
 * the transaction snapshot, threading the invoice bounds it fetched
 * from the F4 bridge.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import { asSatang, type Satang } from '@/lib/money';
import {
  computeRefundableAmount,
  type RefundableAmountInput,
} from '../value-objects/refundable-amount';

/**
 * Branded at boundary per F5R3v2 H-5 — see commit `1203403f`.
 */
export type RefundExceedsRemainderError = {
  readonly kind: 'refund_exceeds_remaining';
  readonly requestedSatang: Satang;
  readonly remainingSatang: Satang;
};

export interface RefundNotExceedingRemainderInput extends RefundableAmountInput {
  readonly newRefundSatang: Satang;
  /**
   * B.1 (#4) — OPTIONAL F4 invoice-credit bounds. When BOTH are supplied
   * (the issue-refund Phase A pre-flight fetches them from the F4 bridge),
   * the remaining is ALSO capped by the invoice's un-credited headroom
   * `invoiceTotalSatang − invoiceCreditedTotalSatang`, and the effective
   * cap is `min(payment-based, invoice-credit-based)`. Both must be present
   * to engage the invoice cap — a lone bound is ignored (treated as "no
   * invoice bound") so a missing operand can never silently zero the min.
   */
  readonly invoiceCreditedTotalSatang?: Satang;
  readonly invoiceTotalSatang?: Satang;
}

export function checkRefundNotExceedingRemainder(
  input: RefundNotExceedingRemainderInput,
): { ok: true; remainingSatang: Satang } | { ok: false; error: RefundExceedsRemainderError } {
  if (input.newRefundSatang <= 0n) {
    // Caller bug — zod at the route boundary already rejects this.
    // Surface a typed error so the invariant is total.
    return {
      ok: false,
      error: {
        kind: 'refund_exceeds_remaining',
        requestedSatang: input.newRefundSatang,
        remainingSatang: asSatang(0n),
      },
    };
  }
  const { remainingSatang: paymentRemainingSatang } = computeRefundableAmount(input);

  // B.1 (#4) — cap by the invoice's un-credited headroom when BOTH F4 bounds
  // are supplied. Reuse `computeRefundableAmount` for the headroom arithmetic
  // (`total − credited`): it applies the SAME non-negative clamp, so an
  // over-credited invoice (credited ≥ total, e.g. from a manual F4 CN) yields
  // 0 headroom → any refund rejected, which is correct (F4 would reject a
  // further CN). The effective remaining is the MIN of both caps.
  let remainingSatang = paymentRemainingSatang;
  if (
    input.invoiceTotalSatang !== undefined &&
    input.invoiceCreditedTotalSatang !== undefined
  ) {
    const { remainingSatang: invoiceHeadroomSatang } = computeRefundableAmount({
      paymentAmountSatang: input.invoiceTotalSatang,
      succeededSumSatang: input.invoiceCreditedTotalSatang,
    });
    // Both operands are branded `Satang`; the ternary result stays branded
    // (no `Number()` coercion — bigint comparison only).
    remainingSatang =
      invoiceHeadroomSatang < paymentRemainingSatang
        ? invoiceHeadroomSatang
        : paymentRemainingSatang;
  }

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
