/**
 * Manual credit note vs a refundable online payment — the read behind the
 * `online_payment_refundable` guard in `issueCreditNote`.
 *
 * A manual credit note moves NO money, yet it consumes the invoice's
 * un-credited headroom (`total − credited`). The F5 refund pre-flight
 * (`checkRefundNotExceedingRemainder`) caps every Stripe refund at that same
 * headroom, so a manual credit note of X on a card / PromptPay-paid invoice
 * removes X from what can still be refunded through the system — and a full
 * one makes the payment unrefundable. The guard makes staff acknowledge that
 * before the credit note is issued; the correct path for returning online
 * money is the payment's Issue refund action, which issues the credit note
 * itself (`sourceRefundId` set, never guarded).
 *
 * NON-LOCKING, like `PendingRefundGuardPort`, for the same lock-order reason:
 * the refund finaliser takes payments/refunds locks before the invoice lock,
 * so an invoice-side lock here would invert that order. The residual window
 * (a payment succeeding between this read and the CN commit) is accepted —
 * an invoice being credited is already `paid`, so its payment has settled.
 */
export type OnlinePaymentRefundableRead =
  /** No succeeded online payment, or it is already fully refunded. */
  | { readonly kind: 'none' }
  /** A succeeded online payment still has money that can be refunded. */
  | { readonly kind: 'refundable'; readonly remainingSatang: bigint }
  /**
   * The payments read failed. The use-case treats this like `refundable`
   * (fail-closed): a refused credit note is recoverable — staff tick the
   * acknowledgement — whereas a stranded online payment is not.
   */
  | { readonly kind: 'unknown' };

export interface OnlinePaymentRefundGuardPort {
  readRefundableOnlinePayment(
    tenantId: string,
    invoiceId: string,
  ): Promise<OnlinePaymentRefundableRead>;
}
