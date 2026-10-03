/**
 * Cancel every PaymentIntent still live at Stripe for an invoice that has
 * just stopped being payable — after a void (follow-up to the #446
 * financial-integrity review, M-a) and after an admin records a manual
 * payment (follow-up to the #452 review, M1).
 *
 * Without this the member's card PaymentIntent stayed live. The PaySheet
 * keeps its `clientSecret` across drawer reopen, so a later confirm went
 * straight to Stripe (never through F5 `initiatePayment`'s non-issued guard),
 * captured money for an invoice that was void or already paid, and
 * confirm-payment's stale-invoice guard auto-refunded it days later — member
 * money held, Stripe fees lost. Stripe card PaymentIntents do not expire on
 * their own.
 *
 * Contract:
 *   - Called AFTER the caller's transaction commits, never inside it. The
 *     implementation locks payment rows; confirm-payment locks
 *     payment → invoice, so doing it under the caller's invoice lock would
 *     invert that order and risk a deadlock. Only wire it where the caller
 *     owns its transaction (see `makeRecordPaymentDeps`); for a manual
 *     payment the admin pay route runs it via
 *     `cancelPendingPaymentsAfterManualPayment`, after its other post-commit
 *     steps.
 *   - BEST-EFFORT. It never changes the caller's outcome; the caller swallows
 *     a throw (metric + log). A PaymentIntent it fails to cancel is retried by
 *     the hourly `sweepPendingPaymentsOnUnpayableInvoices` and, if it is
 *     captured first, refunded by the webhook's stale-invoice auto-refund.
 *
 * Invoicing OWNS the contract; the implementation is the F5 use-case
 * `cancelPendingPaymentsForInvoice`, wired in `invoicing-deps.ts` through the
 * `@/modules/payments` barrel (Constitution Principle III).
 */
export interface PendingPaymentCancellerPort {
  cancelPendingPayments(args: {
    readonly tenantId: string;
    readonly invoiceId: string;
    /** The voiding / paying user — recorded as the actor on the payment audit rows. */
    readonly actorUserId: string;
    readonly requestId: string | null;
    /** Why the invoice stopped being payable; lands on the audit rows. */
    readonly cause: 'invoice_voided' | 'invoice_paid_manually' | 'invoice_already_paid';
  }): Promise<void>;
}
