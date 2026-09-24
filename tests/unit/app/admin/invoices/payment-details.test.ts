/**
 * Invoice detail "Payment details" for a Stripe-paid invoice.
 *
 * `markPaidFromProcessor` stores `payment_method = 'other'`, the PaymentIntent
 * id as the reference, an English machine note ("Paid online via Stripe card
 * (intent=… charge=…)") and the reserved webhook actor as the recorder. The
 * section must show a localisable "Card (online)" / "PromptPay (online)", the
 * system actor instead of its internal e-mail, and no machine note.
 */
import { describe, expect, it } from 'vitest';
import { describePaymentDetails } from '@/app/(staff)/admin/invoices/[invoiceId]/_lib/payment-details';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments';

const STRIPE_CARD_NOTE = 'Paid online via Stripe card (intent=pi_123 charge=ch_456)';
const STRIPE_PROMPTPAY_NOTE = 'Paid online via Stripe PromptPay (intent=pi_789)';

describe('describePaymentDetails', () => {
  it('Stripe card payment: Card (online), recorded by the system, no machine note', () => {
    expect(
      describePaymentDetails({
        paymentMethod: 'other',
        paymentNotes: STRIPE_CARD_NOTE,
        paymentRecordedByUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        onlineMethod: 'card',
      }),
    ).toEqual({ methodKey: 'card_online', recordedBy: { kind: 'system' }, notes: null });
  });

  it('Stripe PromptPay payment: PromptPay (online)', () => {
    expect(
      describePaymentDetails({
        paymentMethod: 'other',
        paymentNotes: STRIPE_PROMPTPAY_NOTE,
        paymentRecordedByUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        onlineMethod: 'promptpay',
      }).methodKey,
    ).toBe('promptpay_online');
  });

  it('falls back to the rail in the machine note when the payment activity is unavailable', () => {
    expect(
      describePaymentDetails({
        paymentMethod: 'other',
        paymentNotes: STRIPE_PROMPTPAY_NOTE,
        paymentRecordedByUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        onlineMethod: null,
      }),
    ).toEqual({ methodKey: 'promptpay_online', recordedBy: { kind: 'system' }, notes: null });
  });

  it('a manually recorded payment is shown as entered', () => {
    expect(
      describePaymentDetails({
        paymentMethod: 'bank_transfer',
        paymentNotes: 'Transfer from KBank',
        paymentRecordedByUserId: 'user-admin-1',
        onlineMethod: null,
      }),
    ).toEqual({
      methodKey: 'bank_transfer',
      recordedBy: { kind: 'user', userId: 'user-admin-1' },
      notes: 'Transfer from KBank',
    });
  });

  it('a manual "other" payment keeps its human note', () => {
    expect(
      describePaymentDetails({
        paymentMethod: 'other',
        paymentNotes: 'Paid by the embassy in person',
        paymentRecordedByUserId: 'user-admin-1',
        onlineMethod: null,
      }),
    ).toEqual({
      methodKey: 'other',
      recordedBy: { kind: 'user', userId: 'user-admin-1' },
      notes: 'Paid by the embassy in person',
    });
  });

  it('no recorder / method yet reads as nothing', () => {
    expect(
      describePaymentDetails({
        paymentMethod: null,
        paymentNotes: null,
        paymentRecordedByUserId: null,
        onlineMethod: null,
      }),
    ).toEqual({ methodKey: null, recordedBy: null, notes: null });
  });
});
