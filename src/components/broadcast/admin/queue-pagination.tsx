/**
 * The /admin/broadcasts queue's keyset footer on AURA cursor `Pagination`
 * (spec 122): the "Showing N of M" summary as its status line (first page
 * only — keyset pages have no offset; the page decides) and the First / Next
 * links. Rendered by the queue between the list and the bulk toolbar (T086a
 * V10). A forward-only keyset, so there is no Previous (AURA 5.84 #197,
 * `showPrevious={false}`). A plain component: the page passes its strings
 * from its own translator.
 */
import { CursorPagination } from '@/components/layout/cursor-pagination';

export function QueuePagination({
  label,
  status,
  firstPageHref,
  nextPageHref,
  focusTargetId,
}: {
  /** The nav's accessible name. */
  readonly label: string;
  /** The "Showing N of M" line, or null when it is not shown. */
  readonly status: string | null;
  /** The cursor-less first page, or null on the first page. */
  readonly firstPageHref: string | null;
  /** The next keyset page, or null on the last page. */
  readonly nextPageHref: string | null;
  /** Where focus goes after a page link (R148: the list, not the page top). */
  readonly focusTargetId?: string;
}): React.ReactElement | null {
  if (nextPageHref === null && firstPageHref === null) return null;
  return (
    <CursorPagination
      label={label}
      showPrevious={false}
      status={status !== null ? <span className="tabular-nums">{status}</span> : null}
      firstHref={firstPageHref ?? undefined}
      nextHref={nextPageHref ?? undefined}
      {...(focusTargetId !== undefined ? { focusTargetId } : {})}
    />
  );
}
