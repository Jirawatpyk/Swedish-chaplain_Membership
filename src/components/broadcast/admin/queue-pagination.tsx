/**
 * The /admin/broadcasts queue's keyset footer on AURA cursor `Pagination`
 * (spec 122): the "Showing N of M" summary as its status line (first page
 * only — keyset pages have no offset) and the First / Next links. Rendered by
 * the queue between the list and the bulk toolbar (T086a V10). A forward-only
 * keyset, so Previous stays disabled.
 */
import { getTranslations } from 'next-intl/server';
import { CursorPagination } from '@/components/layout/cursor-pagination';

export async function renderQueuePagination({
  firstPageHref,
  nextPageHref,
  shown,
  viewTotal,
}: {
  /** The cursor-less first page, or null on the first page. */
  readonly firstPageHref: string | null;
  /** The next keyset page, or null on the last page. */
  readonly nextPageHref: string | null;
  /** Rows on this page. */
  readonly shown: number;
  /** The whole view's count, or null when it is not known. */
  readonly viewTotal: number | null;
}): Promise<React.ReactElement | null> {
  if (nextPageHref === null && firstPageHref === null) return null;
  const t = await getTranslations('admin.broadcasts.queue');
  return (
    <CursorPagination
      label={t('pagination.label')}
      // On the first page only: keyset pages have no offset, so on page 2
      // "Showing 50 of 132" would read as the same first 50.
      status={
        viewTotal !== null && firstPageHref === null ? (
          <span className="tabular-nums">{t('pagination.summary', { shown, total: viewTotal })}</span>
        ) : null
      }
      firstHref={firstPageHref ?? undefined}
      nextHref={nextPageHref ?? undefined}
    />
  );
}
