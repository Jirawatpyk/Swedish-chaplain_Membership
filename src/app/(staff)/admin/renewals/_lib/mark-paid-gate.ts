/**
 * DV-Wave2 ⑤ — single source of truth for "is this cycle mark-paid-able".
 *
 * Extracted from `cycle-admin-actions.tsx` (was module-private
 * `PAYABLE_STATUSES`) so the pipeline ROW action (`pipeline-table.tsx`) and
 * the cycle-detail control share ONE predicate and can never diverge from
 * the route's state-machine guard. The route
 * (`/api/admin/renewals/[cycleId]/mark-paid-offline`) stays the authority —
 * this gate only decides whether to OFFER the affordance, matching the
 * route so we never present a control the API will 409
 * (`cycle_not_payable`).
 *
 * Status alone is not enough: a payable cycle that already carries a live
 * linked bill (the ordinary post-confirm `awaiting_payment` state, or an
 * early confirm while still `upcoming`) is refused by the use-case with
 * `membership_bill_already_exists` — mint-and-pay would be a second §86/4 for
 * the same membership year. Those cycles get "Record payment on {bill}" (the
 * F4 record-payment flow) instead. The use-case guard stays the backstop: it
 * is member-scoped and also catches a live bill that is NOT linked to the
 * cycle, which this UI gate cannot see.
 *
 * `linkedInvoiceId` is USUALLY a live bill for an open cycle — the ordinary
 * void clears the link (`clearLinkedInvoiceForVoidInTx`) — but not always: the
 * void-on-reissue supersede path and pre-unlink voids can leave an open cycle
 * linked to a void invoice. The pipeline row has no invoice status, so it
 * treats any link as live; the cycle-detail page knows the status and uses
 * {@link resolveLiveLinkedBill}, offering mark-paid on a void link — safe,
 * because the use-case clears such a stale link before minting.
 */
import type { CycleStatus } from '@/modules/renewals/client';

/** Statuses where Mark-paid-offline is offered — mirrors the route guard. */
export const PAYABLE_STATUSES: ReadonlySet<CycleStatus> = new Set<CycleStatus>([
  'upcoming',
  'awaiting_payment',
]);

export function shouldOfferMarkPaid(
  status: CycleStatus,
  linkedInvoiceId: string | null,
): boolean {
  return PAYABLE_STATUSES.has(status) && linkedInvoiceId === null;
}

/**
 * The same payable-status window, for a cycle that DOES carry a live linked
 * bill — offer "Record payment on {bill}" where mark-paid would otherwise be.
 */
export function shouldOfferRecordPaymentOnBill(
  status: CycleStatus,
  linkedInvoiceId: string | null,
): linkedInvoiceId is string {
  return PAYABLE_STATUSES.has(status) && linkedInvoiceId !== null;
}

/**
 * The cycle-detail page's view of the linked bill: live unless F4 reports it
 * void. A degraded F4 fetch (hydrated as `status: 'unknown'`, or absent) still
 * counts as live — the link exists, and offering mint-and-pay there would only
 * earn a `membership_bill_already_exists` refusal (fail-closed).
 */
export function resolveLiveLinkedBill(
  linkedInvoiceId: string | null,
  linkedInvoice: {
    readonly invoiceNumber: string | null;
    readonly status: string;
  } | null,
): { readonly invoiceId: string; readonly billNumber: string | null } | null {
  if (linkedInvoiceId === null || linkedInvoice?.status === 'void') {
    return null;
  }
  return {
    invoiceId: linkedInvoiceId,
    billNumber: linkedInvoice?.invoiceNumber ?? null,
  };
}
