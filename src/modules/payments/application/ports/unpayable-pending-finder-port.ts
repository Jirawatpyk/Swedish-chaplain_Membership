/**
 * Cross-tenant read for the hourly retry sweep
 * (`sweepPendingPaymentsOnUnpayableInvoices`): which invoices still have a
 * `pending` payment although the invoice is no longer `issued`.
 *
 * A pending attempt on a void / paid / credited invoice must never capture —
 * the void-time cancel (#447) is best-effort, and this is its retry. Read-only
 * and non-locking: the per-invoice cancel re-locks everything it touches.
 *
 * Age window, measured from the LATER of the attempt's creation and the
 * invoice's last change (when it stopped being payable): `minAgeMinutes`
 * keeps the sweep off attempts the void's own post-commit cancel is still
 * handling; `maxAgeDays` bounds how long a
 * PaymentIntent Stripe keeps refusing to cancel is retried (and audited) after
 * its invoice stopped being payable — past it the 24h `stale-pending-count`
 * gauge and its runbook take over.
 */
export interface UnpayablePendingFinderPort {
  listInvoicesWithPendingOnUnpayable(args: {
    readonly minAgeMinutes: number;
    readonly maxAgeDays: number;
    readonly limit: number;
  }): Promise<ReadonlyArray<{ readonly tenantId: string; readonly invoiceId: string }>>;
}
