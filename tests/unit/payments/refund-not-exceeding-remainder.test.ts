/**
 * B.1 (#4) — refund-not-exceeding-remainder invariant: the pre-flight cap is
 * the MIN of the payment-based remainder and the invoice-credit-based headroom.
 *
 *   remaining = min(
 *     payment.amountSatang − Σ(F5 succeeded refunds),
 *     invoice.totalSatang − invoice.creditedTotalSatang,
 *   )
 *
 * Bug #4: today the pre-flight only caps against the PAYMENT side, so a refund
 * that exceeds what F4 will accept as a credit note (`invoice.total −
 * invoice.credited`, already reduced by a manual F4 credit note) still passes,
 * Stripe moves the money, then F4 rejects the CN → an orphaned Stripe refund.
 *
 * The invoice bounds are OPTIONAL params: omitting them preserves the
 * payment-only cap (backward-compatible with every pre-B.1 caller).
 *
 * Pure domain — no framework / ORM / DB.
 */
import { describe, expect, it } from 'vitest';
import { asSatang } from '@/lib/money';
import { checkRefundNotExceedingRemainder } from '@/modules/payments/domain/invariants/refund-not-exceeding-remainder';

describe('checkRefundNotExceedingRemainder — B.1 (#4) invoice-credit cap', () => {
  // Brief scenario: invoice = payment = 10000; a manual F4 CN of 4000 already
  // exists (credited_total = 4000) → invoice headroom = 6000. remaining =
  // min(payment 10000, invoice 6000) = 6000.
  it('rejects an 8000 refund that clears the payment cap but exceeds the invoice-credit headroom', () => {
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(0n),
      invoiceTotalSatang: asSatang(10_000n),
      invoiceCreditedTotalSatang: asSatang(4_000n),
      newRefundSatang: asSatang(8_000n),
    });
    // Pre-fix (payment-only cap): 8000 ≤ 10000 → ok:true → money would move
    // and F4 would then reject the over-credit CN (orphaned Stripe refund).
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('refund_exceeds_remaining');
      expect(r.error.requestedSatang).toBe(8_000n);
      // The surfaced cap is the invoice-credit headroom (the binding bound).
      expect(r.error.remainingSatang).toBe(6_000n);
    }
  });

  it('allows a 6000 refund that exactly equals the invoice-credit headroom', () => {
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(0n),
      invoiceTotalSatang: asSatang(10_000n),
      invoiceCreditedTotalSatang: asSatang(4_000n),
      newRefundSatang: asSatang(6_000n),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remainingSatang).toBe(6_000n);
  });

  it('caps by the PAYMENT bound when it is the tighter of the two', () => {
    // payment remaining = 10000 − 7000 = 3000; invoice headroom = 10000 − 0
    // = 10000. min = 3000. A 5000 refund is rejected by the payment bound.
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(7_000n),
      invoiceTotalSatang: asSatang(10_000n),
      invoiceCreditedTotalSatang: asSatang(0n),
      newRefundSatang: asSatang(5_000n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.remainingSatang).toBe(3_000n);
  });

  it('caps by the INVOICE bound when it is the tighter of the two', () => {
    // payment remaining = 10000 − 0 = 10000; invoice headroom = 10000 − 9000
    // = 1000. min = 1000. A 2000 refund is rejected by the invoice bound.
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(0n),
      invoiceTotalSatang: asSatang(10_000n),
      invoiceCreditedTotalSatang: asSatang(9_000n),
      newRefundSatang: asSatang(2_000n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.remainingSatang).toBe(1_000n);
  });

  it('rejects ANY positive refund when the invoice is already fully credited (headroom 0)', () => {
    // A manual F4 CN already credited the whole invoice (credited === total)
    // even though the payment shows no F5 refunds yet. A further F5 refund
    // would orphan (F4 rejects the extra CN). remaining = min(10000, 0) = 0.
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(0n),
      invoiceTotalSatang: asSatang(10_000n),
      invoiceCreditedTotalSatang: asSatang(10_000n),
      newRefundSatang: asSatang(1n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.remainingSatang).toBe(0n);
  });

  it('defensively clamps an over-credited invoice (credited > total) to 0 headroom', () => {
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(0n),
      invoiceTotalSatang: asSatang(10_000n),
      invoiceCreditedTotalSatang: asSatang(12_000n),
      newRefundSatang: asSatang(1_000n),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.remainingSatang).toBe(0n);
  });

  it('backward-compatible: with NO invoice bounds it applies the payment-only cap', () => {
    // The sole pre-B.1 behaviour must be unchanged when the optional invoice
    // bounds are omitted (other callers / legacy code paths).
    const ok = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(4_000n),
      newRefundSatang: asSatang(6_000n),
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.remainingSatang).toBe(6_000n);

    const bad = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(4_000n),
      newRefundSatang: asSatang(7_000n),
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.remainingSatang).toBe(6_000n);
  });

  it('ignores the invoice cap when only ONE of the two bounds is supplied (defensive)', () => {
    // Both must be present to engage the invoice cap. A lone total (or lone
    // credited) is treated as "no invoice bound" → payment-only cap. This keeps
    // the min from silently using a 0/undefined for the missing operand.
    const onlyTotal = checkRefundNotExceedingRemainder({
      paymentAmountSatang: asSatang(10_000n),
      succeededSumSatang: asSatang(0n),
      invoiceTotalSatang: asSatang(6_000n),
      newRefundSatang: asSatang(9_000n),
    });
    // payment cap = 10000; invoice bound NOT engaged (credited missing).
    expect(onlyTotal.ok).toBe(true);
    if (onlyTotal.ok) expect(onlyTotal.remainingSatang).toBe(10_000n);
  });
});
