/**
 * T061 — Events list table (F6 Phase 4 / US2 AS1).
 *
 * TanStack Table v8 headless + shadcn Table visual primitives — same
 * pattern as src/components/members/members-table.tsx and
 * src/components/invoicing/invoice-table.tsx. Server-side pagination
 * + filter; the table renders the current page only.
 *
 * Columns:
 *   - Date           (event.startDate, locale-formatted, BE-display
 *                     for th-TH; pure ISO for en/sv)
 *   - Name           (clickable link to /admin/events/[id])
 *   - Category       (raw string from EventCreate or — when null)
 *   - Registrations  (totalRegistrations integer)
 *   - Partner Benefit (badge: visible when isPartnerBenefit OR
 *                       isCulturalEvent; uses lucide Award icon)
 *   - Match Rate     ("NN.N%" with em-dash when total=0)
 *
 * Keyboard nav + a11y:
 *   - Native `<a>` row links — Tab + Enter
 *   - aria-sort hint on the Date column
 *   - sr-only "events table" caption
 */
'use client';

import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { Award, Sparkles } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type EventsListTableRow = {
  readonly eventId: string;
  readonly name: string;
  readonly startDate: string;
  readonly category: string | null;
  readonly totalRegistrations: number;
  readonly matchedRegistrations: number;
  readonly matchRatePct: number;
  readonly isPartnerBenefit: boolean;
  readonly isCulturalEvent: boolean;
  readonly archivedAt: string | null;
};

type Props = {
  readonly rows: readonly EventsListTableRow[];
};

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // BE-display only for `th-TH` per CLAUDE.md timestamp convention.
  // For en + sv use the locale's default Gregorian formatter.
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
  });
  return formatter.format(d);
}

function formatMatchRate(pct: number, total: number): string {
  if (total <= 0) return '—';
  return `${pct.toFixed(1)}%`;
}

export function EventsListTable({ rows }: Props) {
  const t = useTranslations('admin.events.list');
  const locale = useLocale();

  return (
    <Table>
      <TableCaption className="sr-only">{t('tableCaption')}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead aria-sort="descending">{t('columns.date')}</TableHead>
          <TableHead>{t('columns.name')}</TableHead>
          <TableHead>{t('columns.category')}</TableHead>
          <TableHead className="text-right">
            {t('columns.registrations')}
          </TableHead>
          <TableHead>{t('columns.partnerBenefit')}</TableHead>
          <TableHead className="text-right">
            {t('columns.matchRate')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const isArchived = row.archivedAt !== null;
          return (
            <TableRow
              key={row.eventId}
              className={cn(isArchived && 'opacity-60')}
            >
              <TableCell className="text-muted-foreground">
                {formatDate(row.startDate, locale)}
              </TableCell>
              <TableCell>
                <Link
                  href={`/admin/events/${row.eventId}`}
                  className="font-medium underline-offset-4 hover:underline focus-visible:underline"
                >
                  {row.name}
                </Link>
                {isArchived && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {t('badges.archived')}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.category ?? '—'}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.totalRegistrations.toLocaleString(locale)}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1">
                  {row.isPartnerBenefit && (
                    <Badge
                      variant="outline"
                      className="border-sky-300 text-sky-900 dark:border-sky-700 dark:text-sky-200"
                      aria-label={t('badges.partnerBenefit')}
                    >
                      <Award aria-hidden="true" data-icon="inline-start" />
                      <span>{t('badges.partnerBenefit')}</span>
                    </Badge>
                  )}
                  {row.isCulturalEvent && (
                    <Badge
                      variant="outline"
                      className="border-violet-300 text-violet-900 dark:border-violet-700 dark:text-violet-200"
                      aria-label={t('badges.culturalEvent')}
                    >
                      <Sparkles aria-hidden="true" data-icon="inline-start" />
                      <span>{t('badges.culturalEvent')}</span>
                    </Badge>
                  )}
                  {!row.isPartnerBenefit && !row.isCulturalEvent && (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <span className="font-medium">
                  {formatMatchRate(row.matchRatePct, row.totalRegistrations)}
                </span>
                {row.totalRegistrations > 0 && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({row.matchedRegistrations}/{row.totalRegistrations})
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
