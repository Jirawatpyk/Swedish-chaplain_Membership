/**
 * The payment timeline's charge-id row and "View in Stripe" link come from the
 * latest payment that SUCCEEDED at some point. A partial or full refund moves
 * the payment to `partially_refunded` / `refunded`; it was still captured, so
 * the charge reference must stay (that is exactly when staff need it).
 */
import { describe, expect, it } from 'vitest';
import { asSatang } from '@/lib/money';
import { latestSucceededPayment } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline-format';
import { asPaymentId, type Payment } from '@/modules/payments/domain/payment';

function payment(overrides: Partial<Payment>): Payment {
  return {
    id: asPaymentId('pmt_1'),
    tenantId: 'swecham',
    invoiceId: 'inv-1',
    memberId: 'mem-1',
    method: 'card',
    status: 'succeeded',
    amountSatang: asSatang(1_000_000n),
    currency: 'THB',
    processorPaymentIntentId: 'pi_1',
    processorChargeId: 'ch_1',
    processorEnvironment: 'live',
    attemptSeq: 1,
    card: null,
    failureReasonCode: null,
    initiatedAt: new Date('2026-09-23T07:00:00Z'),
    completedAt: new Date('2026-09-23T07:10:00Z'),
    actorUserId: 'user-member-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('latestSucceededPayment', () => {
  it.each(['succeeded', 'partially_refunded', 'refunded'] as const)(
    'keeps a %s payment as the charge reference',
    (status) => {
      expect(latestSucceededPayment([payment({ status })])?.processorChargeId).toBe('ch_1');
    },
  );

  it('ignores failed, canceled and auto-refunded payments', () => {
    expect(
      latestSucceededPayment([
        payment({ status: 'failed' }),
        payment({ status: 'canceled' }),
        payment({ status: 'auto_refunded' }),
      ]),
    ).toBeUndefined();
  });

  it('picks the most recently completed one', () => {
    const older = payment({
      id: asPaymentId('pmt_old'),
      status: 'refunded',
      completedAt: new Date('2026-09-01T00:00:00Z'),
    });
    const newer = payment({
      id: asPaymentId('pmt_new'),
      status: 'partially_refunded',
      completedAt: new Date('2026-09-20T00:00:00Z'),
    });
    expect(latestSucceededPayment([older, newer])?.id).toBe('pmt_new');
  });
});
