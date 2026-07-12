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

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BellOff } from 'lucide-react';
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
  readonly pendingSinceLabel: string;
  readonly expiryLabel: string;
  /**
   * UX-A Bug 2 — true when the cycle carries the async reject-with-refund
   * marker: already rejected, refund settling, awaiting cron convergence to
   * `cancelled`. Drives the "Refund settling" pill + read-only "View" CTA.
   */
  readonly refundSettling: boolean;
}

export interface PendingReviewListProps {
  readonly rows: ReadonlyArray<PendingReviewRow>;
}

export function PendingReviewList({ rows }: PendingReviewListProps) {
  const t = useTranslations('admin.renewals.pendingReview');

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BellOff}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.member')}</TableHead>
          <TableHead>{t('columns.pendingSince')}</TableHead>
          <TableHead>{t('columns.expiry')}</TableHead>
          <TableHead className="text-right">{t('columns.action')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.cycleId}>
            <TableCell className="font-medium">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{row.companyName}</span>
                {row.refundSettling && (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-900 dark:text-amber-100 dark:ring-amber-600">
                    {t('settlingPill')}
                  </span>
                )}
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {row.pendingSinceLabel}
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
