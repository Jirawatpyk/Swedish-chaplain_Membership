'use client';

/**
 * 090 Bug 2 — reveal the §86/4 RC receipt download on the invoice DETAIL page
 * after an ONLINE payment, WITHOUT a manual refresh.
 *
 * The gap this closes
 * -------------------
 * On online payment, `<PaySheet>` fires a SINGLE `router.refresh()` the moment
 * Stripe's client SDK reports success — which RACES the webhook chain
 * (`payment_intent.succeeded` → mark invoice paid → mint §86/4 RC → render RC
 * PDF async). At that refresh the server usually still shows `status='issued'`
 * / `receiptPdfStatus=null`, so the only auto-reveal mechanism —
 * `<ReceiptStatusWatcher>` — never mounts, because the page gated it behind
 * `status === 'paid' && receiptPdfStatus === 'pending'`. Result: the receipt
 * download button did not appear until the member reloaded by hand.
 *
 * The fix
 * -------
 * Mount the SAME status-poll watcher during the client-side OPTIMISTIC-paid
 * window too (the `dispatchInvoicePaid` signal already flips the page badge to
 * "Paid" and hides Pay-now — see `./optimistic-paid`). The watcher polls
 * `/api/portal/invoices/{id}/receipt/status`, which returns the raw
 * `receiptPdfStatus` — `null` while the invoice is still `issued`, then
 * `pending`, then `rendered` — and treats anything non-terminal as "keep
 * polling". So it rides the full issued → paid → RC-rendered transition and
 * calls `router.refresh()` exactly when the RC PDF is ready, revealing the
 * download. No new polling mechanism is invented; this reuses the existing
 * `<ReceiptStatusWatcher>` + status endpoint.
 *
 * This client component is rendered UNCONDITIONALLY by the detail page so its
 * `useOptimisticPaid` subscription is live when the same-tab `dispatchInvoicePaid`
 * CustomEvent fires from the pay-sheet — it then mounts the watcher immediately
 * (it returns `null` when there is nothing to poll).
 */
import { useOptimisticPaid } from './optimistic-paid';
import { ReceiptStatusWatcher } from '../../_components/receipt-status-watcher';

export interface ReceiptRevealProps {
  readonly invoiceId: string;
  /** Server truth: the receipt download is already rendered + shown (`showReceiptPdf`). */
  readonly receiptAvailable: boolean;
  /** Server truth: paid + `receiptPdfStatus === 'pending'` (async RC mid-render). */
  readonly receiptAsyncPending: boolean;
  /** Server truth: paid + `receiptPdfStatus === 'failed'` (terminal render failure). */
  readonly receiptAsyncFailed: boolean;
}

/**
 * Pure decision: should the detail page keep polling the receipt-status
 * endpoint to auto-reveal the download? Extracted so every branch is
 * unit-pinned without mounting the client subtree.
 */
export function shouldPollReceipt(opts: {
  readonly optimisticallyPaid: boolean;
  readonly receiptAvailable: boolean;
  readonly receiptAsyncPending: boolean;
  readonly receiptAsyncFailed: boolean;
}): boolean {
  // Already downloadable — nothing to poll (avoids a wasted `router.refresh()`
  // during the lingering 60 s optimistic window after the receipt appeared).
  if (opts.receiptAvailable) return false;
  // Terminal server-side render failure — the page renders its own support
  // block and the reconcile cron is the recovery path, not client polling.
  if (opts.receiptAsyncFailed) return false;
  // Poll when the server explicitly marks the async RC render pending, OR when
  // the client just paid online (optimistic) and the server (webhook → DB → RC
  // render) has not caught up yet — the just-paid gap that left the button
  // hidden until a manual refresh.
  return opts.receiptAsyncPending || opts.optimisticallyPaid;
}

export function ReceiptReveal({
  invoiceId,
  receiptAvailable,
  receiptAsyncPending,
  receiptAsyncFailed,
}: ReceiptRevealProps): React.ReactElement | null {
  const optimisticallyPaid = useOptimisticPaid(invoiceId);
  if (
    !shouldPollReceipt({
      optimisticallyPaid,
      receiptAvailable,
      receiptAsyncPending,
      receiptAsyncFailed,
    })
  ) {
    return null;
  }
  // The `block` variant carries the aria-live "your tax receipt is being
  // generated" announcement + reassurance copy — the correct member-facing
  // state right after a successful payment while the RC PDF renders.
  return <ReceiptStatusWatcher invoiceId={invoiceId} variant="block" />;
}
