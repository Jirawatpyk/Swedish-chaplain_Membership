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
import { asSatang } from '@/lib/money';
import { buildEvents } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline';
import { asPaymentId, type Payment } from '@/modules/payments/domain/payment';
import {
  SYSTEM_ACTOR_STRIPE_WEBHOOK,
  SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY,
} from '@/modules/payments';
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
    amountSatang: asSatang(1_000_000n),
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
    amountSatang: asSatang(100_000n),
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
    // Pin the system-actor sentinel so a refactor swapping in
    // `p.actorUserId` (member UUID) is caught. `_LEGACY` = string
    // form used by `buildEvents`; the UUID form is `SYSTEM_ACTOR_
    // STRIPE_WEBHOOK` (used by F4 invoice.payment_recorded_by_user_id
    // and tested in the `invoice_paid` event below).
    expect(events[1]?.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY);
  });

  it('adds payment_failed terminal with system:stripe-webhook actor (security-relevant)', () => {
    // R3-fix Imp#4 (2026-04-26): payment_failed shares the same
    // security boundary as refund_failed/refund_succeeded — webhook-
    // initiated terminal vs human-initiated. The previous test
    // asserted only event presence. Pin the actor sentinel so a
    // refactor swapping in `p.actorUserId` (the member's UUID) is
    // caught by CI rather than slipping into production.
    const events = buildEvents(
      [makeCardPayment({ status: 'failed', completedAt: T1 })],
      [],
      null,
      null,
    );
    const terminal = events.find((e) => e.type === 'payment_failed');
    expect(terminal).toBeDefined();
    expect(terminal?.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY);
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

  it('adds refund_succeeded terminal with system:stripe-webhook actor (security-relevant)', () => {
    // R2-fix CG-A (2026-04-26): assert actorUserId is the system
    // sentinel — this is a security boundary (webhook-initiated
    // refund vs. human-initiated). The previous test only asserted
    // the terminal event existed, so a refactor swapping in
    // `r.initiatorUserId` would have passed silently.
    const events = buildEvents(
      [],
      [makeRefund({ status: 'succeeded', completedAt: T2 })],
      null,
      null,
    );
    const terminal = events.find((e) => e.type === 'refund_succeeded');
    expect(terminal).toBeDefined();
    expect(terminal?.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY);
  });

  it('adds refund_failed terminal with system:stripe-webhook actor (security-relevant)', () => {
    // R2-fix CG-A (2026-04-26): same security pin as refund_succeeded.
    const events = buildEvents(
      [],
      [makeRefund({ status: 'failed', completedAt: T2 })],
      null,
      null,
    );
    const terminal = events.find((e) => e.type === 'refund_failed');
    expect(terminal).toBeDefined();
    expect(terminal?.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY);
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

  // -------------------------------------------------------------------------
  // Gap C (2026-07-12) — auto_refunded payment terminal event.
  //
  // The stale-invoice / late-charge auto-refund (migration 0240) flips a
  // payment `pending → auto_refunded` and writes NO `refunds` row. Before
  // this fix the payment fell through the succeeded/failed/canceled switch
  // and rendered as a lone "Payment initiated" row. It must surface its
  // own terminal `auto_refunded` event. It stays OUT of the succeeded
  // lineage, so no `invoice_paid` row is synthesized.
  // -------------------------------------------------------------------------
  it('emits an auto_refunded terminal event for an auto_refunded payment (system actor)', () => {
    const events = buildEvents(
      [makeCardPayment({ status: 'auto_refunded', completedAt: T1 })],
      [],
      null,
      null,
    );
    const types = events.map((e) => e.type as string);
    expect(types).toContain('payment_initiated');
    expect(types).toContain('auto_refunded');
    const terminal = events.find((e) => (e.type as string) === 'auto_refunded');
    // Auto-refund is booked by the webhook-dispatch tail — not the member.
    expect(terminal?.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY);
    expect(terminal?.timestamp).toBe(T1);
  });

  it('does NOT emit invoice_paid for an auto_refunded payment even when paidAt is set', () => {
    // `hasSucceeded` filters on status='succeeded'; auto_refunded is
    // excluded from the succeeded lineage, so the invoice was never
    // settled by this attempt → no invoice_paid row.
    const events = buildEvents(
      [makeCardPayment({ status: 'auto_refunded', completedAt: T1 })],
      [],
      T2.toISOString(),
      null,
    );
    expect(events.find((e) => e.type === 'invoice_paid')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Gap B (2026-07-12) — pending async refund settling affordance.
  //
  // An async Stripe refund lands as a `pending` row (completedAt === null).
  // Before this fix it rendered only a neutral "Refund initiated" row,
  // indistinguishable from the first half of a completed refund. It must
  // get a distinct warning-tone `refund_pending` event alongside the
  // initiation row — and NO terminal event until it settles.
  // -------------------------------------------------------------------------
  it('emits a refund_pending event for a pending refund, alongside refund_initiated', () => {
    const events = buildEvents(
      [],
      [makeRefund({ status: 'pending', completedAt: null })],
      null,
      null,
    );
    const types = events.map((e) => e.type as string);
    expect(types).toContain('refund_initiated');
    expect(types).toContain('refund_pending');
    expect(types).not.toContain('refund_succeeded');
    expect(types).not.toContain('refund_failed');
    const pending = events.find((e) => (e.type as string) === 'refund_pending');
    expect(pending?.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK_LEGACY);
    expect(pending?.subjectId).toBe('rfnd_test_1');
  });

  it('does NOT emit refund_pending once the refund has settled', () => {
    const events = buildEvents(
      [],
      [makeRefund({ status: 'succeeded', completedAt: T2 })],
      null,
      null,
    );
    const types = events.map((e) => e.type as string);
    expect(types).not.toContain('refund_pending');
    expect(types).toContain('refund_succeeded');
  });
});
