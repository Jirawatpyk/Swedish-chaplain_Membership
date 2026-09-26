'use client';

/**
 * Shared table pagination — combines total-count summary + numbered
 * page navigation. Used by every admin list page (members, users,
 * future plans, future invoices).
 *
 * Design:
 *   - Shows "Showing X–Y of Z" summary above the page selector
 *   - AURA `Pagination` (spec 122 US1): numbered page links with
 *     ellipses, previous / next, `aria-current="page"`, compact on phones
 *   - Preserves ALL existing searchParams (q=, show_archived=, etc.)
 *     so filters survive pagination
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
import { Pagination } from '@jirawatpyk/aura-react';

export type TablePaginationProps = {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** Override pathname (defaults to current pathname). */
  readonly baseHref?: string;
  /** Override the searchParams source (testing / deep-link injection). */
  readonly searchParams?: URLSearchParams;
  /**
   * Announce the summary to AT on change (default). Pass `false` when the
   * page already owns a live region for the same count — two polite regions
   * updating together read the number twice (108 PR-D review L2).
   */
  readonly live?: boolean;
};

export function TablePagination({
  page,
  pageSize,
  total,
  baseHref,
  searchParams: injected,
  live = true,
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

  return (
    <div
      className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between"
      data-slot="table-pagination"
    >
      <p
        className="text-sm text-muted-foreground"
        aria-live={live ? 'polite' : undefined}
        aria-atomic={live ? 'true' : undefined}
      >
        {total === 0
          ? t('emptyCount')
          : t('summary', {
              from: firstRow,
              to: lastRow,
              total,
            })}
      </p>

      {/* Spec 122 US1 — AURA Pagination in server mode: real links (the
          previous / next arrows too) built from the current query, so the
          page stays a server render and the back button works. It compacts
          itself below 640px. */}
      {totalPages > 1 && (
        <Pagination
          pageCount={totalPages}
          page={safePage}
          getHref={makeHref}
          linkComponent={Link}
        />
      )}
    </div>
  );
}
