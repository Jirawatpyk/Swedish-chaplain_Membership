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
 * **Round 2 review-fix S-9 / Round 3 review-fix CR1** (canonical brand
 * adoption): the cross-module input types use the **canonical** branded
 * types from each owning module — `TenantId` from `@/modules/members`
 * (F3 owns the tenant-id concept across all member-related surfaces)
 * and `InvoiceId` from `@/modules/invoicing` (F4 owns invoice ids).
 * This prevents the parallel-type-system trap that an `@/lib/branded-ids`
 * fork would create (Round 3 R3-CR1 finding) — a `TenantId` from
 * F3 is the same nominal type everywhere it's used. Arg-swap protection
 * stays — `issueRefundForInvoice({ tenantId: invoiceId, invoiceId:
 * tenantId })` (swapped) refuses to type-check. The 3 other F8 cross-
 * module ports (`f4-invoicing-bridge`, `plan-lookup-for-renewal`,
 * `event-attendees-port`) adopt the same pattern incrementally as
 * they're touched (F9).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

import type { TenantId } from '@/modules/members';
import type { InvoiceId } from '@/modules/invoicing';

export interface IssueRefundForInvoiceInput {
  readonly tenantId: TenantId;
  readonly invoiceId: InvoiceId;
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
