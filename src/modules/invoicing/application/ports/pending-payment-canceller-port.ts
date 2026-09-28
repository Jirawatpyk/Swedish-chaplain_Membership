/**
 * Follow-up to the #446 financial-integrity review (M-a) — after an invoice
 * is voided, cancel every PaymentIntent still live at Stripe for it.
 *
 * Without this a void left the member's card PaymentIntent live. The PaySheet
 * keeps its `clientSecret` across drawer reopen, so a later confirm went
 * straight to Stripe (never through F5 `initiatePayment`'s non-issued guard),
 * captured money for a voided invoice, and confirm-payment's stale-invoice
 * guard auto-refunded it days later — member money held, Stripe fees lost.
 * Stripe card PaymentIntents do not expire on their own.
 *
 * Contract:
 *   - Called AFTER the void's Phase-1 transaction commits, never inside it.
 *     The implementation locks payment rows; confirm-payment locks
 *     payment → invoice, so doing it under the void's invoice lock would
 *     invert that order and risk a deadlock.
 *   - BEST-EFFORT. It never changes the void's outcome; the caller swallows a
 *     throw (metric + log). A PaymentIntent it fails to cancel is still caught
 *     by the webhook's stale-invoice auto-refund.
 *
 * Invoicing OWNS the contract; the implementation is the F5 use-case
 * `cancelPendingPaymentsForInvoice`, wired in `invoicing-deps.ts` through the
 * `@/modules/payments` barrel (Constitution Principle III).
 */
export interface PendingPaymentCancellerPort {
  cancelPendingPaymentsForVoidedInvoice(args: {
    readonly tenantId: string;
    readonly invoiceId: string;
    /** The voiding user — recorded as the actor on the payment audit rows. */
    readonly actorUserId: string;
    readonly requestId: string | null;
  }): Promise<void>;
}
