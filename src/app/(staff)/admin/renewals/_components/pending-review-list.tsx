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
            <TableCell className="font-medium">{row.companyName}</TableCell>
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
                {t('openAction')}
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
