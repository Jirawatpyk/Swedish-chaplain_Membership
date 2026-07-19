/**
 * 107-auto-invoice — the auto-renewal review-queue view predicate and the
 * Origin-select URL patch, extracted as pure functions so both can be unit
 * tested (the page is an RSC and the filters are a client component; neither
 * is a natural home for logic this load-bearing).
 *
 * The queue is `origin='auto_renewal' AND status='draft'` — the definition
 * `listInvoicesPaged` and `page.tsx` both already state in prose ("the review
 * queue IS drafts"), now enforced. Keying the queue CHROME (heading, table
 * caption, badge column, per-row enrichment) on origin alone let legally-final
 * tax documents render as work items: a paid FY2025 §86/4 wore a red
 * `critical` "Would be refused — coverage has lapsed" badge, and the table
 * announced "List of auto-renewal drafts awaiting review" to screen readers.
 *
 * Origin stays a plain filter: `origin=auto_renewal` with any other status
 * lists those invoices under the ordinary list framing, which is honest.
 * `showQueueActions` (invoice-table.tsx) was already status-gated this way —
 * these predicates bring the rest of the surface into line with it.
 */

/** The status the queue view imposes on itself. */
const QUEUE_STATUS = 'draft';
const QUEUE_ORIGIN = 'auto_renewal';

export function isAutoRenewalQueueView(params: {
  readonly origin: string | undefined;
  readonly status: string | undefined;
}): boolean {
  return params.origin === QUEUE_ORIGIN && params.status === QUEUE_STATUS;
}

/**
 * URL patch for the Origin select. Selecting the queue pushes `status=draft`
 * alongside the origin — the select is the queue's only entry point, so
 * without this the queue becomes unreachable once the view predicate requires
 * drafts.
 *
 * Leaving the queue clears ONLY a `draft` status, i.e. exactly the value the
 * queue imposed; any other status is the admin's own selection and survives.
 * The unavoidable ambiguity (an admin who independently chose `draft` while
 * browsing the queue) resolves toward the wider view, which is the recoverable
 * direction — they can re-pick `draft` in one click, whereas being silently
 * pinned to drafts-only after switching to "All origins" reads as missing data.
 */
export function originFilterPatch(
  // `string | null` — the Select's `onValueChange` can emit null on clear.
  nextOrigin: string | null,
  currentStatus: string | null,
): { readonly origin: string | null; readonly status?: string | null } {
  if (nextOrigin === QUEUE_ORIGIN) {
    return { origin: QUEUE_ORIGIN, status: QUEUE_STATUS };
  }
  const origin = nextOrigin && nextOrigin !== 'all' ? nextOrigin : null;
  return currentStatus === QUEUE_STATUS ? { origin, status: null } : { origin };
}
