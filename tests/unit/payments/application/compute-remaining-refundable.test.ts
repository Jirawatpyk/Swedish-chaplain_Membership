/**
 * F5 2026-05-17 polish — unit coverage for `computeRemainingRefundable`
 * (the pure money-arithmetic projection exported alongside
 * `loadInvoicePaymentActivity`). Kept in its own file because the
 * function deserves dedicated cases (12+ branches: payment status
 * filter, refund status filter, paymentId scoping, multi-payment
 * sorting, null completedAt edge case, immutability guarantee).
 *
 * Closes load-invoice-payment-activity.ts coverage gap from
 * 43% L / 50% F → 100% L / 100% F per Constitution Principle II
 * (security-critical money flow). Threshold entry in
 * vitest.config.ts:`load-invoice-payment-activity.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  computeRemainingRefundable,
  type LoadInvoicePaymentActivityOutput,
} from '@/modules/payments/application/use-cases/load-invoice-payment-activity';
import type { RefundActivityDto } from '@/modules/payments/application/ports/payments-repo';
import type { Payment } from '@/modules/payments/domain/payment';
import { asSatang } from '@/lib/money';

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_test' as Payment['id'],
    tenantId: 'swecham',
    invoiceId: 'inv_test',
    memberId: 'mem_1',
    actorUserId: 'u_1',
    method: 'card',
    status: 'succeeded',
    amountSatang: asSatang(1_000_000n),
    currency: 'THB',
    processorPaymentIntentId: 'pi_test',
    processorChargeId: null,
    processorAccountId: null,
    attemptSeq: 1,
    idempotencyKey: 'idem_1',
    initiatedAt: new Date('2026-05-17T10:00:00Z'),
    completedAt: new Date('2026-05-17T10:01:00Z'),
    failedAt: null,
    canceledAt: null,
    lastPaymentErrorCode: null,
    lastPaymentErrorMessage: null,
    paymentNotes: null,
    createdAt: new Date('2026-05-17T10:00:00Z'),
    updatedAt: new Date('2026-05-17T10:01:00Z'),
    ...overrides,
  } as Payment;
}

function makeRefund(overrides: Partial<RefundActivityDto> = {}): RefundActivityDto {
  return {
    refundId: 'rf_test',
    paymentId: 'pay_test',
    status: 'succeeded',
    amountSatang: asSatang(100_000n),
    reason: 'admin_initiated',
    initiatedAt: new Date('2026-05-17T11:00:00Z'),
    completedAt: new Date('2026-05-17T11:01:00Z'),
    processorRefundId: 'rfnd_test',
    ...overrides,
  } as RefundActivityDto;
}

describe('computeRemainingRefundable — pure refund-remainder projection', () => {
  it('returns null when no succeeded payment exists', () => {
    const r = computeRemainingRefundable({ payments: [], refunds: [] });
    expect(r).toBeNull();
  });

  it('returns null when all payments are non-succeeded (pending/failed/canceled)', () => {
    const r = computeRemainingRefundable({
      payments: [
        makePayment({ status: 'pending' }),
        makePayment({ status: 'failed', id: 'pay_failed' as Payment['id'] }),
        makePayment({ status: 'canceled', id: 'pay_canceled' as Payment['id'] }),
      ],
      refunds: [],
    });
    expect(r).toBeNull();
  });

  it('returns full amount when succeeded payment has no refunds', () => {
    const r = computeRemainingRefundable({
      payments: [makePayment({ amountSatang: asSatang(500_000n) })],
      refunds: [],
    });
    expect(r).not.toBeNull();
    expect(r!.paymentId).toBe('pay_test');
    expect(r!.remainingSatang).toBe(500_000n);
  });

  it('returns remainder after one partial succeeded refund', () => {
    const r = computeRemainingRefundable({
      payments: [makePayment({ amountSatang: asSatang(1_000_000n) })],
      refunds: [makeRefund({ amountSatang: asSatang(300_000n) })],
    });
    expect(r!.remainingSatang).toBe(700_000n);
  });

  it('returns remainder after multiple partial succeeded refunds', () => {
    const r = computeRemainingRefundable({
      payments: [makePayment({ amountSatang: asSatang(1_000_000n) })],
      refunds: [
        makeRefund({ refundId: 'rf_1', amountSatang: asSatang(200_000n) }),
        makeRefund({ refundId: 'rf_2', amountSatang: asSatang(300_000n) }),
      ],
    });
    expect(r!.remainingSatang).toBe(500_000n);
  });

  it('returns null when refunds equal payment (fully refunded)', () => {
    const r = computeRemainingRefundable({
      payments: [makePayment({ amountSatang: asSatang(1_000_000n) })],
      refunds: [makeRefund({ amountSatang: asSatang(1_000_000n) })],
    });
    expect(r).toBeNull();
  });

  it('returns null when refunds exceed payment (defensive — invariant should prevent)', () => {
    const r = computeRemainingRefundable({
      payments: [makePayment({ amountSatang: asSatang(500_000n) })],
      refunds: [makeRefund({ amountSatang: asSatang(600_000n) })],
    });
    expect(r).toBeNull();
  });

  it('IGNORES failed + pending refunds — only succeeded reduce remainder', () => {
    const r = computeRemainingRefundable({
      payments: [makePayment({ amountSatang: asSatang(1_000_000n) })],
      refunds: [
        makeRefund({ refundId: 'rf_failed', status: 'failed', amountSatang: asSatang(200_000n) }),
        makeRefund({ refundId: 'rf_pending', status: 'pending', amountSatang: asSatang(300_000n) }),
      ],
    });
    expect(r!.remainingSatang).toBe(1_000_000n);
  });

  it('IGNORES refunds for OTHER payments — paymentId scoping', () => {
    const r = computeRemainingRefundable({
      payments: [makePayment({ id: 'pay_a' as Payment['id'], amountSatang: asSatang(1_000_000n) })],
      refunds: [
        makeRefund({ paymentId: 'pay_OTHER', amountSatang: asSatang(500_000n) }),
        makeRefund({ paymentId: 'pay_a', amountSatang: asSatang(200_000n), refundId: 'rf_match' }),
      ],
    });
    expect(r!.remainingSatang).toBe(800_000n);
  });

  it('accepts partially_refunded status as succeeded-payment candidate', () => {
    const r = computeRemainingRefundable({
      payments: [
        makePayment({
          status: 'partially_refunded',
          amountSatang: asSatang(1_000_000n),
        }),
      ],
      refunds: [makeRefund({ amountSatang: asSatang(200_000n) })],
    });
    expect(r!.remainingSatang).toBe(800_000n);
  });

  it('picks the MOST RECENT succeeded payment (completedAt DESC)', () => {
    const r = computeRemainingRefundable({
      payments: [
        makePayment({
          id: 'pay_old' as Payment['id'],
          completedAt: new Date('2026-05-15T10:00:00Z'),
          amountSatang: asSatang(100_000n),
        }),
        makePayment({
          id: 'pay_new' as Payment['id'],
          completedAt: new Date('2026-05-17T10:00:00Z'),
          amountSatang: asSatang(999_999n),
        }),
      ],
      refunds: [],
    });
    expect(r!.paymentId).toBe('pay_new');
    expect(r!.remainingSatang).toBe(999_999n);
  });

  it('handles null completedAt (treated as epoch 0 for sort)', () => {
    const r = computeRemainingRefundable({
      payments: [
        makePayment({
          id: 'pay_no_completedAt' as Payment['id'],
          completedAt: null,
          amountSatang: asSatang(100_000n),
        }),
        makePayment({
          id: 'pay_with_completedAt' as Payment['id'],
          completedAt: new Date('2026-05-17T10:00:00Z'),
          amountSatang: asSatang(200_000n),
        }),
      ],
      refunds: [],
    });
    expect(r!.paymentId).toBe('pay_with_completedAt');
  });

  it('does not mutate caller arrays (immutability)', () => {
    const payments: Payment[] = [makePayment()];
    const refunds: RefundActivityDto[] = [makeRefund()];
    const input: LoadInvoicePaymentActivityOutput = { payments, refunds };
    computeRemainingRefundable(input);
    expect(payments).toHaveLength(1);
    expect(refunds).toHaveLength(1);
  });
});
