'use client';

/**
 * Shared table pagination — combines total-count summary + numbered
 * page navigation. Used by every admin list page (members, users,
 * future plans, future invoices).
 *
 * Design:
 *   - Shows "Showing X–Y of Z" summary above the page selector
 *   - Numbered pages with ellipsis for windows of 5 (1 … 4 5 6 … 10)
 *   - Prev / Next with aria-disabled at boundaries
 *   - Preserves ALL existing searchParams (q=, show_archived=, etc.)
 *     so filters survive pagination
 *   - WCAG 2.1 AA: role=navigation, aria-current=page, keyboard-first
 *
 * Built on the stock shadcn `<Pagination />` primitive at
 * `src/components/ui/pagination.tsx` (no repo-specific fork).
 *
 * Usage:
 *
 *   <TablePagination
 *     page={2}
 *     pageSize={50}
 *     total={131}
 *     baseHref="/admin/members"
 *   />
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';

export type TablePaginationProps = {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** Override pathname (defaults to current pathname). */
  readonly baseHref?: string;
  /** Override the searchParams source (testing / deep-link injection). */
  readonly searchParams?: URLSearchParams;
};

/**
 * Compute the visible page-number window for a "1 … 4 5 6 … 10" layout.
 * Always shows first + last; fills the middle with a sliding 3-page window
 * around the current page. Returns `number | 'ellipsis'` tokens ready to
 * render.
 */
export function buildPageWindow(
  current: number,
  total: number,
): ReadonlyArray<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const result: Array<number | 'ellipsis'> = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) result.push('ellipsis');
  for (let p = start; p <= end; p++) result.push(p);
  if (end < total - 1) result.push('ellipsis');
  result.push(total);
  return result;
}

export function TablePagination({
  page,
  pageSize,
  total,
  baseHref,
  searchParams: injected,
}: TablePaginationProps) {
  const t = useTranslations('pagination');
  const pathname = usePathname();
  const currentSearchParams = useSearchParams();
  const source = injected ?? currentSearchParams;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const firstRow = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastRow = Math.min(safePage * pageSize, total);

  const makeHref = (targetPage: number): string => {
    const params = new URLSearchParams(source?.toString() ?? '');
    if (targetPage === 1) {
      params.delete('page');
    } else {
      params.set('page', String(targetPage));
    }
    const qs = params.toString();
    return qs ? `${baseHref ?? pathname}?${qs}` : (baseHref ?? pathname);
  };

  const window = buildPageWindow(safePage, totalPages);
  const onFirstPage = safePage <= 1;
  const onLastPage = safePage >= totalPages;

  return (
    <div
      className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between"
      data-slot="table-pagination"
    >
      <p
        className="text-sm text-muted-foreground"
        aria-live="polite"
        aria-atomic="true"
      >
        {total === 0
          ? t('emptyCount')
          : t('summary', {
              from: firstRow,
              to: lastRow,
              total,
            })}
      </p>

      {totalPages > 1 && (
        <Pagination className="mx-0 w-auto justify-end">
          <PaginationContent>
            <PaginationItem>
              {onFirstPage ? (
                <DisabledEdge text={t('previous')} side="prev" />
              ) : (
                <PaginationPrevious
                  href={makeHref(safePage - 1)}
                  text={t('previous')}
                />
              )}
            </PaginationItem>
            {window.map((token, idx) =>
              token === 'ellipsis' ? (
                <PaginationItem key={`ellipsis-${idx}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              ) : (
                <PaginationItem key={token}>
                  <PaginationLink
                    href={makeHref(token)}
                    isActive={token === safePage}
                    aria-label={t('page', { page: token })}
                  >
                    {token}
                  </PaginationLink>
                </PaginationItem>
              ),
            )}
            <PaginationItem>
              {onLastPage ? (
                <DisabledEdge text={t('next')} side="next" />
              ) : (
                <PaginationNext
                  href={makeHref(safePage + 1)}
                  text={t('next')}
                />
              )}
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}

/**
 * The shadcn stock primitive renders anchor tags without a built-in
 * disabled state. We swap to a non-link <span> at the boundaries so
 * keyboard + screen reader users aren't told to navigate to a dead
 * target. Visual style mirrors the stock Prev/Next look at 50% opacity.
 */
function DisabledEdge({
  text,
  side,
}: {
  text: string;
  side: 'prev' | 'next';
}) {
  return (
    <span
      aria-disabled
      tabIndex={-1}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium opacity-50 cursor-not-allowed',
        side === 'prev' ? 'pl-2' : 'pr-2',
      )}
    >
      {side === 'prev' && (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="hidden sm:block">{text}</span>
      {side === 'next' && (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

// Unused Link import guard — keep for future <Link>-wrapping variants
void Link;
