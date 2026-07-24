/**
 * 8A (money-remediation) — a NON-LOCKING count of in-flight (`status='pending'`)
 * refunds on an invoice's payment(s).
 *
 * `issueCreditNote` (manual) and `voidInvoice` consult it to REFUSE while a
 * refund is settling. Without the guard, a manual credit note / void issued
 * mid-refund flips the invoice to `credited`/`void`, so the refund's own
 * Phase-B §86/10 then declines against it — the Stripe-settled refund is
 * stranded `pending` forever (the sweep retrying into the same permanent
 * refusal) and blocks every future refund on the payment via
 * `ctx.pendingCount > 0`.
 *
 * NON-LOCKING — a plain `COUNT`. It MUST NOT take a `FOR UPDATE`/`FOR SHARE`
 * lock. The refund finaliser holds `refunds FOR NO KEY UPDATE` and then reaches
 * the credit-note bridge's `invoices FOR UPDATE`; a lock here (invoice-side →
 * refunds) inverts that acquisition order and DEADLOCKS. The residual TOCTOU —
 * a refund that BEGINS between this read and the CN/void commit — is accepted
 * ON PURPOSE: closing it would need the cross-module lock reorder this
 * non-locking read exists to avoid, and its money outcome is defined by the
 * refund side (8B converts a raced void to a waive; 8C terminalises a permanent
 * decline). The guard NARROWS the window; it does not claim to close it.
 *
 * The guard is DELIBERATELY amount-unaware (count all pending, block on any).
 * An amount-aware guard would reintroduce the racy credited-remainder headroom
 * computation this whole remediation is removing.
 */
export interface PendingRefundGuardPort {
  /**
   * Count `status='pending'` refunds for `(tenantId, invoiceId)`. Non-locking.
   * Returns 0 when none (or, at the composition seam, when the underlying read
   * failed — fail-open, since a rare count-read hiccup must not hard-fail an
   * admin credit note / void; the residual window is already accepted).
   */
  countPendingRefundsForInvoice(
    tenantId: string,
    invoiceId: string,
  ): Promise<number>;
}
