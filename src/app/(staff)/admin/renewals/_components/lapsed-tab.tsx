/**
 * `LapsedTab` panel — renders when `?urgency=lapsed`.
 *
 * Shows lapsed cycles with reason badges. Reactivate + Archive CTAs
 * are reserved for US3 P1 (self-service renewal post-lapse) + US7
 * (member archive flow); detail-page actions (Cancel +
 * mark-paid-offline) handle the admin recovery path today.
 *
 * The list reuses `PipelineTable` since the row shape is identical;
 * this wrapper adds an explanatory banner so admins understand the
 * operational difference between active + lapsed members.
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
  | 'grace_expired'
  | 'payment_failed'
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
  // T115a: forward-compat for the two specific reasons; same red treatment
  // as catch-all `lapsed` until Phase 5 wires the dispatcher decision branch.
  grace_expired:
    'bg-red-50 text-red-900 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900',
  payment_failed:
    'bg-rose-50 text-rose-900 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-900',
  // UX R5 / Mobile-a11y: dark-mode ring contrast — `dark:ring-gray-700`
  // on `dark:bg-gray-900` was too low (3.0:1 borderline). Bump to -600
  // for clearer pill outline. Same -600 floor applied across the
  // tonal palette so every variant has a visible boundary on dark.
  cancelled:
    'bg-gray-100 text-gray-700 ring-gray-300 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-600',
  paid:
    'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-700',
  completed_offline:
    'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-700',
  admin_reactivated:
    'bg-blue-50 text-blue-900 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-700',
  admin_rejected_with_refund:
    'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-700',
  // -700 (was -600 inconsistently) so this severe state stays
  // dominant in scan order matching `lapsed`/`payment_failed`.
  pending_reactivation_timed_out:
    'bg-orange-50 text-orange-900 ring-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-700',
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
                      emailUnverified={r.emailUnverified}
                    />
                  </TableCell>
                  <TableCell>
                    <CycleExpiresCell expiresAt={r.expiresAt} />
                  </TableCell>
                  <TableCell>
                    {/*
                      K9: removed redundant aria-label — text content
                      already serves as the accessible name. Older
                      VoiceOver double-announces when aria-label
                      duplicates visible text on non-interactive spans.
                    */}
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                        REASON_VARIANT_CLASSES[reason] ??
                          REASON_VARIANT_CLASSES.lapsed,
                      )}
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
