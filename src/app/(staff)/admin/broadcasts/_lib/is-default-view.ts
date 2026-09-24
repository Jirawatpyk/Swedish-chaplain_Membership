/**
 * Task 3 review fix (Important, 2026-08-01-broadcast-review-queue-pr1).
 *
 * Pure, framework-free helper — no `runInTenant`/`requireSession`
 * imports — so it's unit-testable in isolation from the page's server
 * boundary. Must stay consistent with `queue-filters.tsx`'s
 * `hasAnyFilter`, which treats `fromDate`/`toDate` as active filters
 * too (they drive the "Reset" button). The prior inline
 * `isDefaultView` expression in `page.tsx` omitted the date params, so
 * a `?fromDate=...` URL rendered the overdue banner + truncation note
 * as if the view were pristine — the "banner over a filtered subset"
 * bug the design explicitly warns against. Inert today (date params
 * aren't wired into the query yet) but becomes live the moment date
 * filtering ships.
 */
export interface QueueViewParams {
  readonly status_all?: string;
  readonly status?: string | string[];
  readonly memberId?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  /** F119 T119 — the Upcoming sends preset (`sort=scheduled_for&from=now`). */
  readonly sort?: string;
  readonly from?: string;
}

/**
 * True only on the pristine default queue view (no filter of any kind
 * active) — matches queue-filters' `hasAnyFilter`, so the overdue
 * banner never renders over a filtered subset (the pager renders on every
 * view since the F119 dashboard UX review H1).
 */
export function isDefaultBroadcastView(p: QueueViewParams): boolean {
  return (
    p.status_all !== '1' &&
    p.status === undefined &&
    p.memberId === undefined &&
    p.fromDate === undefined &&
    p.toDate === undefined &&
    p.sort === undefined &&
    p.from === undefined
  );
}
