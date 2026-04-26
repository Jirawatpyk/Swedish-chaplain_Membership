/**
 * Verify-fix CG-5 (2026-04-26) — branch coverage for the
 * `buildEvents` synthesizer that drives the admin payment-timeline.
 *
 * `buildEvents` is a pure function with 8 visible branches:
 *   1. payment_initiated emit (always when payment exists)
 *   2. payment_succeeded terminal (when status='succeeded')
 *   3. payment_failed terminal (when status='failed')
 *   4. payment_canceled terminal (when status='canceled', actor = member)
 *   5. invoice_paid gate (hasSucceeded && invoicePaidAtIso !== null)
 *      — actor falls back to system:stripe-webhook when
 *      invoicePaymentRecordedByUserId is null (post-verify-fix C1+E2)
 *   6. refund_initiated emit (always per refund)
 *   7. refund_succeeded terminal (when refund status='succeeded')
 *   8. refund_failed terminal (when refund status='failed')
 *
 * Pure function → no Vitest mocks needed.
 */
import { describe, expect, it } from 'vitest';
import { buildEvents } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline';
import { asPaymentId, type Payment } from '@/modules/payments/domain/payment';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments';
import type { RefundActivityDto } from '@/modules/payments';

const T0 = new Date('2026-04-26T10:00:00Z');
const T1 = new Date('2026-04-26T10:00:30Z');
const T2 = new Date('2026-04-26T10:01:00Z');

function makeCardPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: asPaymentId('pmt_test_card'),
    tenantId: 'swecham',
    invoiceId: 'inv-1',
    memberId: 'mem-1',
    method: 'card',
    status: 'pending',
    amountSatang: 1_000_000n,
    currency: 'THB',
    processorPaymentIntentId: 'pi_test',
    processorChargeId: null,
    processorEnvironment: 'test',
    attemptSeq: 1,
    card: null,
    failureReasonCode: null,
    initiatedAt: T0,
    completedAt: null,
    actorUserId: 'user-member-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

function makeRefund(overrides: Partial<RefundActivityDto> = {}): RefundActivityDto {
  return {
    refundId: 'rfnd_test_1',
    paymentId: 'pmt_test_card',
    invoiceId: 'inv-1',
    status: 'pending',
    amountSatang: 100_000n,
    reason: 'duplicate payment',
    initiatedAt: T1,
    completedAt: null,
    initiatorUserId: 'user-admin-1',
    processorRefundId: null,
    failureReasonCode: null,
    creditNoteId: null,
    ...overrides,
  };
}

describe('buildEvents', () => {
  it('emits payment_initiated for any payment regardless of status', () => {
    const events = buildEvents(
      [makeCardPayment({ status: 'pending' })],
      [],
      null,
      null,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('payment_initiated');
    expect(events[0]?.actorUserId).toBe('user-member-1');
  });

  it('adds payment_succeeded terminal with system actor when status=succeeded', () => {
    const events = buildEvents(
      [makeCardPayment({ status: 'succeeded', completedAt: T1 })],
      [],
      null,
      null,
    );
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe('payment_succeeded');
    expect(events[1]?.actorUserId).toBe(`system:stripe-webhook`);
  });

  it('adds payment_failed terminal when status=failed', () => {
    const events = buildEvents(
      [makeCardPayment({ status: 'failed', completedAt: T1 })],
      [],
      null,
      null,
    );
    expect(events.find((e) => e.type === 'payment_failed')).toBeDefined();
  });

  it('adds payment_canceled terminal with the member actor (not the webhook)', () => {
    const events = buildEvents(
      [
        makeCardPayment({
          status: 'canceled',
          completedAt: T1,
          actorUserId: 'user-member-1',
        }),
      ],
      [],
      null,
      null,
    );
    const cancelEvent = events.find((e) => e.type === 'payment_canceled');
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.actorUserId).toBe('user-member-1');
  });

  it('omits the invoice_paid event when no payment succeeded', () => {
    const events = buildEvents(
      [makeCardPayment({ status: 'failed', completedAt: T1 })],
      [],
      T1.toISOString(),
      null,
    );
    expect(events.find((e) => e.type === 'invoice_paid')).toBeUndefined();
  });

  it('omits the invoice_paid event when invoicePaidAt is null', () => {
    const events = buildEvents(
      [makeCardPayment({ status: 'succeeded', completedAt: T1 })],
      [],
      null,
      null,
    );
    expect(events.find((e) => e.type === 'invoice_paid')).toBeUndefined();
  });

  it('emits invoice_paid with the supplied recorder id when present (verify-fix E2)', () => {
    const events = buildEvents(
      [makeCardPayment({ status: 'succeeded', completedAt: T1 })],
      [],
      T2.toISOString(),
      SYSTEM_ACTOR_STRIPE_WEBHOOK,
    );
    const paid = events.find((e) => e.type === 'invoice_paid');
    expect(paid).toBeDefined();
    expect(paid?.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK);
  });

  it('falls back to system:stripe-webhook when invoicePaymentRecordedByUserId is null', () => {
    const events = buildEvents(
      [makeCardPayment({ status: 'succeeded', completedAt: T1 })],
      [],
      T2.toISOString(),
      null,
    );
    const paid = events.find((e) => e.type === 'invoice_paid');
    expect(paid?.actorUserId).toBe('system:stripe-webhook');
  });

  it('emits refund_initiated for each refund row', () => {
    const events = buildEvents([], [makeRefund(), makeRefund({ refundId: 'rfnd_test_2' })], null, null);
    const inits = events.filter((e) => e.type === 'refund_initiated');
    expect(inits).toHaveLength(2);
  });

  it('adds refund_succeeded terminal when refund status=succeeded', () => {
    const events = buildEvents(
      [],
      [makeRefund({ status: 'succeeded', completedAt: T2 })],
      null,
      null,
    );
    expect(events.find((e) => e.type === 'refund_succeeded')).toBeDefined();
  });

  it('adds refund_failed terminal when refund status=failed', () => {
    const events = buildEvents(
      [],
      [makeRefund({ status: 'failed', completedAt: T2 })],
      null,
      null,
    );
    expect(events.find((e) => e.type === 'refund_failed')).toBeDefined();
  });

  it('returns events sorted by timestamp ascending', () => {
    const events = buildEvents(
      [
        makeCardPayment({ status: 'succeeded', completedAt: T1 }),
      ],
      [makeRefund({ initiatedAt: T2, status: 'succeeded', completedAt: new Date('2026-04-26T10:01:30Z') })],
      T1.toISOString(),
      null,
    );
    const timestamps = events.map((e) => e.timestamp.getTime());
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);
  });
});
