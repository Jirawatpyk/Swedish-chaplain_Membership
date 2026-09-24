/**
 * What the invoice detail "Payment details" section shows.
 *
 * `markPaidFromProcessor` records a Stripe payment with `payment_method =
 * 'other'` (the F4 enum has no online rails), the PaymentIntent id as the
 * reference, an English machine note ("Paid online via Stripe card
 * (intent=… charge=…)") and the reserved webhook actor as the recorder. Shown
 * raw, that reads as "Other", an internal e-mail and an untranslated note. This
 * maps it to a localisable online method, a system recorder, and no note (the
 * intent/charge ids are already in the Reference field and Payment activity).
 * Manually recorded payments pass through unchanged. Pure.
 */
import { isSystemActor } from './system-actor';

export type PaymentDetailsMethodKey =
  | 'bank_transfer'
  | 'cheque'
  | 'cash'
  | 'other'
  | 'card_online'
  | 'promptpay_online'
  | 'online';

export interface PaymentDetailsView {
  /** i18n key under `admin.invoices.detail.payment.methods`, or null. */
  readonly methodKey: PaymentDetailsMethodKey | null;
  readonly recordedBy:
    | { readonly kind: 'system' }
    | { readonly kind: 'user'; readonly userId: string }
    | null;
  readonly notes: string | null;
}

/** Prefix of the note `markPaidFromProcessor` writes (`describeProcessorMethod`). */
const PROCESSOR_NOTE = /^Paid online via Stripe (card|PromptPay) \(/;

const MANUAL_METHODS = new Set<string>(['bank_transfer', 'cheque', 'cash', 'other']);

export function describePaymentDetails(input: {
  readonly paymentMethod: string | null;
  readonly paymentNotes: string | null;
  readonly paymentRecordedByUserId: string | null;
  /** Rail of the invoice's succeeded F5 payment, when the activity loaded. */
  readonly onlineMethod: 'card' | 'promptpay' | null;
}): PaymentDetailsView {
  const recordedBy: PaymentDetailsView['recordedBy'] =
    input.paymentRecordedByUserId === null
      ? null
      : isSystemActor(input.paymentRecordedByUserId)
        ? { kind: 'system' }
        : { kind: 'user', userId: input.paymentRecordedByUserId };

  const noteRail = input.paymentNotes?.match(PROCESSOR_NOTE)?.[1] ?? null;
  const paidByProcessor =
    input.paymentMethod === 'other' &&
    (recordedBy?.kind === 'system' || noteRail !== null);

  if (paidByProcessor) {
    const rail =
      input.onlineMethod ??
      (noteRail === 'card' ? 'card' : noteRail === 'PromptPay' ? 'promptpay' : null);
    return {
      methodKey: rail === null ? 'online' : `${rail}_online`,
      recordedBy,
      notes: noteRail !== null ? null : input.paymentNotes,
    };
  }

  return {
    methodKey:
      input.paymentMethod !== null && MANUAL_METHODS.has(input.paymentMethod)
        ? (input.paymentMethod as PaymentDetailsMethodKey)
        : null,
    recordedBy,
    notes: input.paymentNotes,
  };
}
