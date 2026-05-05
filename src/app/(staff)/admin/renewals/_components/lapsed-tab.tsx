/**
 * F8 Phase 3 Wave H4 · T072 — `LapsedTab` panel.
 *
 * Renders when `?urgency=lapsed`. Shows lapsed cycles with reason
 * badges + Reactivate / Archive CTAs (both stub-disabled in Phase 3
 * — Reactivate ships in US3 P1 follow-on, Archive in US7).
 *
 * For Phase 3 the actual list reuses `PipelineTable` since the row
 * shape is identical. This wrapper adds an explanatory banner so
 * admins understand the operational difference between active +
 * lapsed members.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CycleTierCell,
  CycleCompanyCell,
  CycleExpiresCell,
} from '@/components/renewals/cycle-cells';
import { cn } from '@/lib/utils';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { PipelineRow } from '@/modules/renewals/client';

type LapsedReasonKey =
  | 'paid'
  | 'cancelled'
  | 'lapsed'
  | 'completed_offline'
  | 'admin_reactivated'
  | 'admin_rejected_with_refund'
  | 'pending_reactivation_timed_out';

export interface LapsedTabProps {
  readonly rows: ReadonlyArray<PipelineRow>;
}

const REASON_VARIANT_CLASSES: Record<string, string> = {
  lapsed:
    'bg-red-50 text-red-900 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900',
  cancelled:
    'bg-gray-100 text-gray-700 ring-gray-300 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700',
  paid:
    'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900',
  completed_offline:
    'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900',
  admin_reactivated:
    'bg-blue-50 text-blue-900 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-900',
  admin_rejected_with_refund:
    'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900',
  pending_reactivation_timed_out:
    'bg-orange-50 text-orange-900 ring-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-600',
};

export function LapsedTab({ rows }: LapsedTabProps) {
  const t = useTranslations('admin.renewals.lapsed');
  const tTable = useTranslations('admin.renewals.table');
  const tReason = useTranslations('admin.renewals.lapsedReason');

  return (
    <div className="flex flex-col gap-3">
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{t('banner.title')}</AlertTitle>
        <AlertDescription>{t('banner.description')}</AlertDescription>
      </Alert>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tTable('columns.tier')}</TableHead>
            <TableHead>{tTable('columns.company')}</TableHead>
            <TableHead>{tTable('columns.expires')}</TableHead>
            <TableHead>{t('columns.reason')}</TableHead>
            <TableHead className="sr-only">
              {tTable('columns.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={5}
                className="text-center text-muted-foreground py-8"
              >
                {tTable('noRows')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => {
              const reason: LapsedReasonKey = (r.closedReason ?? 'lapsed') as LapsedReasonKey;
              const reasonLabel = tReason(reason);
              return (
                <TableRow key={r.cycleId}>
                  <TableCell>
                    <CycleTierCell tier={r.tierBucket} />
                  </TableCell>
                  <TableCell>
                    <CycleCompanyCell
                      memberId={r.memberId}
                      companyName={r.companyName}
                    />
                  </TableCell>
                  <TableCell>
                    <CycleExpiresCell expiresAt={r.expiresAt} />
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                        REASON_VARIANT_CLASSES[reason] ??
                          REASON_VARIANT_CLASSES.lapsed,
                      )}
                      aria-label={reasonLabel}
                    >
                      {reasonLabel}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/renewals/${r.cycleId}`}
                      className="text-sm text-primary hover:underline"
                      aria-label={t('viewDetailFor', {
                        company: r.companyName || r.memberId,
                      })}
                    >
                      {t('viewDetail')}
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
