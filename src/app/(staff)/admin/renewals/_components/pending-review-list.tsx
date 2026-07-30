/**
 * 070 F8 item #18 — `PendingReviewList`.
 *
 * Renders the "Pending review" discovery table: cycles in
 * `pending_admin_reactivation` that need an admin approve/reject decision.
 * Each row links to the cycle-detail page where the approve / reject-with-
 * refund actions live.
 *
 * Pre-formatted date strings (already locale-/BE-formatted on the server)
 * are passed in so this client component stays locale-agnostic — matching
 * the cycle-detail page's day-grain date treatment.
 *
 * UX-A Bug 2: a row whose cycle carries the async reject-with-refund marker
 * (`refundSettling`) has ALREADY been decided (rejected; refund settling) — it
 * only sits in this pending-status list until the reconcile cron converges it
 * to `cancelled`. It renders a distinct "Refund settling" pill and a read-only
 * "View" CTA (not "Review") so the queue doesn't overstate open work.
 */
'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowDownIcon, ArrowUpIcon, BellOff } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/shell/empty-state';

export interface PendingReviewRow {
  readonly cycleId: string;
  readonly companyName: string;
  /**
   * B4 — the F3 member id when the batch enrichment resolved this cycle's
   * member. Drives the `/admin/members/{memberId}` company link. `null` when
   * the member is absent from the map (archived / cross-tenant-hidden) — the
   * cell then renders the company text (a cycle short-id fallback) plainly.
   */
  readonly memberId: string | null;
  /**
   * B4 — the pre-formatted `SCCM-NNNN` member number (server-formatted with the
   * per-tenant prefix). `null` when the member is absent from the batch map.
   */
  readonly memberNumberDisplay: string | null;
  readonly pendingSinceLabel: string;
  /**
   * B3 — the raw `enteredPendingAt` epoch (ms) the client sorts on. Kept
   * separate from `pendingSinceLabel` (which is the localized/BE display
   * string): sorting a formatted date string is locale-fragile, so the
   * ordering keys off this numeric value. `NaN` (missing timestamp) sorts last.
   */
  readonly pendingSinceEpoch: number;
  readonly expiryLabel: string;
  /**
   * UX-A Bug 2 — true when the cycle carries the async reject-with-refund
   * marker: already rejected, refund settling, awaiting cron convergence to
   * `cancelled`. Drives the "Refund settling" pill + read-only "View" CTA.
   */
  readonly refundSettling: boolean;
  /**
   * B3 — true when the cycle has been pending longer than the aging threshold
   * (`PENDING_REVIEW_AGING_DAYS`). Drives the subtle amber "Aged {n}d" chip.
   */
  readonly isAged: boolean;
  /** B3 — whole days this cycle has been pending (chip label + title). */
  readonly agingDays: number;
}

export interface PendingReviewListProps {
  readonly rows: ReadonlyArray<PendingReviewRow>;
}

export function PendingReviewList({ rows }: PendingReviewListProps) {
  const t = useTranslations('admin.renewals.pendingReview');

  // B3 — client-side sort on the RAW pending-since epoch (never the localized
  // display string). Default 'asc' = oldest-first so the most-aged decisions
  // lead. The list is small + fully materialised (no pagination), so a client
  // toggle is sufficient and adds no server param.
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const aBad = !Number.isFinite(a.pendingSinceEpoch);
      const bBad = !Number.isFinite(b.pendingSinceEpoch);
      // A missing timestamp (NaN) sorts LAST in both directions — it can never
      // be "the most aged" nor jump the newest-first order.
      if (aBad && bBad) return 0;
      if (aBad) return 1;
      if (bBad) return -1;
      return sortDir === 'asc'
        ? a.pendingSinceEpoch - b.pendingSinceEpoch
        : b.pendingSinceEpoch - a.pendingSinceEpoch;
    });
    return copy;
  }, [rows, sortDir]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BellOff}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
      />
    );
  }

  const SortIcon = sortDir === 'asc' ? ArrowUpIcon : ArrowDownIcon;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.member')}</TableHead>
          {/* B3 — sortable "Pending since". `aria-sort` lives on the
              columnheader (WCAG 1.3.1 / 4.1.2); the button carries the action
              label (what the next click does) + the direction caret. Mirrors
              the pipeline's sortable-header treatment (button/anchor + caret). */}
          <TableHead
            aria-sort={sortDir === 'asc' ? 'ascending' : 'descending'}
          >
            <button
              type="button"
              onClick={() =>
                setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
              }
              aria-label={t(
                sortDir === 'asc'
                  ? 'sortPendingSinceToNewest'
                  : 'sortPendingSinceToOldest',
              )}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              {t('columns.pendingSince')}
              <SortIcon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          </TableHead>
          <TableHead>{t('columns.expiry')}</TableHead>
          <TableHead className="text-right">{t('columns.action')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedRows.map((row) => (
          <TableRow key={row.cycleId}>
            <TableCell className="font-medium">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {/* B4 — company links to the F3 member (escalation-queue +
                    invoice-table parity); a member absent from the batch map
                    degrades to plain text (a cycle short-id, never a broken
                    `/admin/members/` link with an empty id). */}
                {row.memberId !== null ? (
                  <Link
                    href={`/admin/members/${row.memberId}`}
                    className="font-medium text-primary underline-offset-4 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                  >
                    {row.companyName}
                  </Link>
                ) : (
                  <span>{row.companyName}</span>
                )}
                {/* B4 — SCCM member number in muted secondary text (members-
                    table / invoice-table convention); tabular-nums so the
                    NNNN digits align down the column. */}
                {row.memberNumberDisplay !== null && (
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    {row.memberNumberDisplay}
                  </span>
                )}
                {row.refundSettling && (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-900 dark:text-amber-100 dark:ring-amber-600">
                    {t('settlingPill')}
                  </span>
                )}
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{row.pendingSinceLabel}</span>
                {/* B3 — subtle amber "Aged {n}d" chip on decisions lingering
                    past the threshold. Reuses the `settlingPill` amber styling
                    for visual consistency (never a new colour); placed here (not
                    the Member cell) so it sits beside the pending date it
                    describes and never clashes with the "Refund settling" pill. */}
                {row.isAged && (
                  <span
                    title={t('agedChipTitle', { days: row.agingDays })}
                    className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-900 dark:text-amber-100 dark:ring-amber-600"
                  >
                    {t('agedChip', { days: row.agingDays })}
                  </span>
                )}
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {row.expiryLabel}
            </TableCell>
            <TableCell className="text-right">
              <Link
                href={`/admin/renewals/${row.cycleId}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {/* UX-A Bug 2: read-only "View" for a decided (refund-settling)
                    row so the queue doesn't imply open review work. */}
                {row.refundSettling ? t('viewAction') : t('openAction')}
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
