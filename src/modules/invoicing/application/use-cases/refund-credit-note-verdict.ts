/**
 * Spec 122 US8b follow-up — "does refunding this invoice owe a §86/10
 * ใบลดหนี้?", answered from a loaded invoice.
 *
 * One composition for every reader that starts from an `Invoice`: the refund
 * dialog's credit-note preview (`previewRefundCreditNote`) and the invoice
 * detail page, which needs the answer before the dialog opens so its
 * description never promises a credit note F4 waives. It feeds
 * `resolveRefundCreditNoteRequirement` exactly as the F5 refund pre-flight
 * does (`payments/infrastructure/invoicing-bridge.ts` →
 * `getInvoiceCreditedTotal`): `isSection105` through the shared
 * `inferEventDocumentKind ∘ resolveBuyerIsVatRegistrant`, never re-derived
 * from TIN presence, and a missing snapshot reported separately so it blocks
 * rather than waives.
 *
 * Pure — no I/O.
 */
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import {
  inferEventDocumentKind,
  resolveBuyerIsVatRegistrant,
} from '@/modules/invoicing/domain/document-kind';
import {
  resolveRefundCreditNoteRequirement,
  type CreditNoteWaiverReason,
  type RefundCreditNoteRequirement,
} from '@/modules/invoicing/domain/refund-credit-note-requirement';

export function refundCreditNoteRequirementFor(
  inv: Pick<
    Invoice,
    'status' | 'invoiceSubject' | 'memberId' | 'memberIdentitySnapshot' | 'receiptPdfStatus'
  >,
): RefundCreditNoteRequirement {
  return resolveRefundCreditNoteRequirement({
    status: inv.status,
    isSection105:
      inferEventDocumentKind(
        inv.invoiceSubject,
        resolveBuyerIsVatRegistrant(inv.memberId, inv.memberIdentitySnapshot),
      ) === 'receipt_separate',
    hasIdentitySnapshot: inv.memberIdentitySnapshot != null,
    receiptPdfStatus: inv.receiptPdfStatus,
  });
}

/**
 * The waiver reason when F4 owes no credit note for this invoice's refunds,
 * else `null` — including a blocked gate, which the refund refuses on its own
 * with its own message.
 */
export function refundCreditNoteWaiverReasonFor(
  inv: Parameters<typeof refundCreditNoteRequirementFor>[0],
): CreditNoteWaiverReason | null {
  const requirement = refundCreditNoteRequirementFor(inv);
  return requirement.kind === 'waive' ? requirement.reason : null;
}
