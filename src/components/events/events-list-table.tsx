/**
 * Events list table (F6 Phase 4 / US2 AS1).
 *
 * TanStack Table v8 headless + shadcn Table visual primitives — same
 * pattern as src/components/members/members-table.tsx and
 * src/components/invoicing/invoice-table.tsx. Server-side pagination
 * + filter; the table renders the current page only.
 *
 * Columns:
 * - Date           (event.startDate, locale-formatted, BE-display
 * for th-TH; pure ISO for en/sv)
 * - Name           (clickable link to /admin/events/[id])
 * - Category       (raw string from EventCreate or — when null)
 * - Registrations  (totalRegistrations integer)
 * - Partner Benefit (badge: visible when isPartnerBenefit OR
 * isCulturalEvent; uses lucide Award icon)
 * - Match Rate     ("NN.N%" with em-dash when total=0)
 *
 * Keyboard nav + a11y:
 * - Native `<a>` row links — Tab + Enter
 * - aria-sort hint on the Date column
 * - sr-only "events table" caption
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
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { EventId } from '@/modules/events';

export type EventsListTableRow = {
  // brand is compile-only — cheap win;
  // catches accidental ID-swap bugs at the Server→Client prop boundary.
  readonly eventId: EventId;
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

// Date formatter uses the shared `formatLocalisedDate` helper which
// honours the Thai Buddhist Era calendar on `th`/`th-TH` per CLAUDE.md
// § Conventions. Storage stays UTC Gregorian; display adds 543 years
// for Thai user-facing surfaces only.
function formatDate(iso: string, locale: string): string {
  return formatLocalisedDate(iso, locale, { dateStyle: 'medium' });
}

function formatMatchRate(pct: number, total: number): string {
  if (total <= 0) return '—';
  return `${pct.toFixed(1)}%`;
}

export function EventsListTable({ rows }: Props) {
  const t = useTranslations('admin.events.list');
  const locale = useLocale();

  return (
    <Table className="min-w-[640px]">
      <TableCaption className="sr-only">{t('tableCaption')}</TableCaption>
      <TableHeader>
        <TableRow>
          {/*
           * no real column-sort wired
           * (server pagination only with fixed start_date DESC order).
           * A hard-coded `aria-sort="descending"` would advertise a
           * sortable column that doesn't react to user input. Drop it
           * until sort UI lands (Phase 10 or smart-feature follow-up).
           */}
          <TableHead>{t('columns.date')}</TableHead>
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
                      className="border-sky-600 text-sky-900 dark:border-sky-500 dark:text-sky-100"
                      aria-label={t('badges.partnerBenefit')}
                    >
                      <Award aria-hidden="true" data-icon="inline-start" />
                      <span>{t('badges.partnerBenefit')}</span>
                    </Badge>
                  )}
                  {row.isCulturalEvent && (
                    <Badge
                      variant="outline"
                      className="border-violet-600 text-violet-900 dark:border-violet-500 dark:text-violet-100"
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
