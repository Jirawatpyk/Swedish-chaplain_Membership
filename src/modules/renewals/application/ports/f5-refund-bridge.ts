/**
 * F8 → F5 cross-module bridge port (Phase 5 Wave A.5 — T137 / T138).
 *
 * F8's admin-reject-reactivation + reconcile-pending-reactivations
 * flows need to refund the renewal payment that was held in
 * `pending_admin_reactivation` (FR-005d). F5's `issueRefund` use-case
 * needs `paymentId` (not `invoiceId`) + a positive `amountSatang`,
 * which means F8 first has to look up the succeeded payment for the
 * cycle's linked invoice + read the refundable balance.
 *
 * Encapsulating this two-step "find payment for invoice → issue full
 * refund" into a single bridge method keeps F8's use-cases free of F5
 * internals + lets the production adapter compose F5's
 * `loadInvoicePaymentActivity` + `issueRefund` use-cases. Mirrors the
 * existing `f4-invoice-bridge.ts` precedent for F8 → F4.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface IssueRefundForInvoiceInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** Free-text reason persisted on F5 refund row + carried in audit. */
  readonly reason: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly requestId: string | null;
}

export type IssueRefundForInvoiceResult =
  | {
      readonly status: 'refunded';
      readonly refundId: string;
      readonly creditNoteId: string;
      readonly creditNoteNumber: string;
    }
  | {
      readonly status: 'no_payment_found';
      /**
       * No succeeded payment exists against this invoice — admin can
       * still reject the reactivation but no refund is required (the
       * `pending_admin_reactivation` state was entered without a
       * cleared payment, e.g. via a now-resolved manual override).
       */
    }
  | {
      readonly status: 'refund_failed';
      /** F5 error code (`processor_unavailable`, `f4_bridge_error`, etc.). */
      readonly errorCode: string;
      readonly detail: string;
    };

export interface F5RefundBridge {
  issueRefundForInvoice(
    input: IssueRefundForInvoiceInput,
  ): Promise<IssueRefundForInvoiceResult>;
}
