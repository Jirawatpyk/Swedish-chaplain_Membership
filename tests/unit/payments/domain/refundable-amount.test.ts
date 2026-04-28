/**
 * T106 + T107 — RefundableAmount + refund-not-exceeding-remainder unit tests.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeRefundableAmount } from '@/modules/payments/domain/value-objects/refundable-amount';
import { checkRefundNotExceedingRemainder } from '@/modules/payments/domain/invariants/refund-not-exceeding-remainder';

describe('computeRefundableAmount', () => {
  it('returns full amount when no refunds yet', () => {
    expect(
      computeRefundableAmount({
        paymentAmountSatang: 5_350_000n,
        succeededSumSatang: 0n,
      }),
    ).toEqual({ remainingSatang: 5_350_000n, fullyRefunded: false });
  });

  it('returns remaining when partial refunds exist', () => {
    expect(
      computeRefundableAmount({
        paymentAmountSatang: 5_350_000n,
        succeededSumSatang: 1_500_000n,
      }),
    ).toEqual({ remainingSatang: 3_850_000n, fullyRefunded: false });
  });

  it('clamps to zero + fullyRefunded=true when sum equals payment', () => {
    expect(
      computeRefundableAmount({
        paymentAmountSatang: 5_350_000n,
        succeededSumSatang: 5_350_000n,
      }),
    ).toEqual({ remainingSatang: 0n, fullyRefunded: true });
  });

  it('clamps to zero + fullyRefunded=true even when sum exceeds payment (defensive)', () => {
    expect(
      computeRefundableAmount({
        paymentAmountSatang: 5_350_000n,
        succeededSumSatang: 6_000_000n,
      }),
    ).toEqual({ remainingSatang: 0n, fullyRefunded: true });
  });

  it('throws on negative paymentAmountSatang', () => {
    expect(() =>
      computeRefundableAmount({
        paymentAmountSatang: -1n,
        succeededSumSatang: 0n,
      }),
    ).toThrow(RangeError);
  });

  it('throws on negative succeededSumSatang', () => {
    expect(() =>
      computeRefundableAmount({
        paymentAmountSatang: 100n,
        succeededSumSatang: -1n,
      }),
    ).toThrow(RangeError);
  });

  it('property: remaining + sum = payment when sum ≤ payment', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000n }),
        fc.bigInt({ min: 0n, max: 100_000_000n }),
        (payment, sum) => {
          fc.pre(sum <= payment);
          const r = computeRefundableAmount({
            paymentAmountSatang: payment,
            succeededSumSatang: sum,
          });
          expect(r.remainingSatang + sum).toBe(payment);
          expect(r.fullyRefunded).toBe(payment === sum);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('checkRefundNotExceedingRemainder (FR-011b invariant)', () => {
  it('ok when newRefund ≤ remaining', () => {
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: 5_350_000n,
      succeededSumSatang: 1_500_000n,
      newRefundSatang: 3_850_000n,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remainingSatang).toBe(3_850_000n);
  });

  it('err refund_exceeds_remaining when newRefund > remaining', () => {
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: 5_350_000n,
      succeededSumSatang: 4_000_000n,
      newRefundSatang: 2_000_000n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('refund_exceeds_remaining');
      expect(r.error.requestedSatang).toBe(2_000_000n);
      expect(r.error.remainingSatang).toBe(1_350_000n);
    }
  });

  it('err refund_exceeds_remaining when newRefund ≤ 0 (defensive)', () => {
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: 5_350_000n,
      succeededSumSatang: 0n,
      newRefundSatang: 0n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.requestedSatang).toBe(0n);
      expect(r.error.remainingSatang).toBe(0n);
    }
  });

  it('exact-match boundary: newRefund === remaining → ok', () => {
    const r = checkRefundNotExceedingRemainder({
      paymentAmountSatang: 5_350_000n,
      succeededSumSatang: 0n,
      newRefundSatang: 5_350_000n,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.remainingSatang).toBe(5_350_000n);
  });
});
