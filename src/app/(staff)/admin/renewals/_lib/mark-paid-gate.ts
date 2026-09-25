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
 * `linkedInvoiceId` non-null ⇒ live bill for an OPEN cycle: voiding the linked
 * invoice clears the link (`clearLinkedInvoiceForVoidInTx`), so an open cycle
 * never keeps pointing at a void one.
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
