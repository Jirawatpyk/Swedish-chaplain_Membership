/**
 * Events list table (F6 Phase 4 / US2 AS1).
 *
 * Spec 122 US9a (T902): AURA's DataTable as the `Admin-events` board draws it
 * (columns Date, Name, Category, Registrations, Partner benefit, Match rate),
 * edge to edge inside the list card, and a card per event below 640px
 * (`Admin-events-mobile`). Server-side pagination + filters: the table renders
 * the current page in the server's order (start date, newest first) and has no
 * sortable column.
 *
 * - Date: `formatLocalisedDate` (Buddhist Era on `th`, storage stays UTC).
 * - Name: a link to the event, with an "Archived" badge.
 * - Partner benefit: the partner and cultural badges, or a dash.
 * - Match rate: "83.3% · Strong" with "35 of 42" under it; the band word is
 *   shown, as the board draws it (Strong ≥ 80, Fair ≥ 50, Weak below), and the
 *   rate is a dash for an event with no registrations.
 */
'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Award, Sparkles } from 'lucide-react';
import { Badge, DataTable, type DataTableColumn } from '@jirawatpyk/aura-react';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { EventId } from '@/modules/events';
import { EVENTS_LIST_COLUMN_LAYOUT } from './events-list-columns';

type MatchRateBand = 'high' | 'medium' | 'low' | 'none';

function bandForPct(total: number, pct: number): MatchRateBand {
  if (total <= 0) return 'none';
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'medium';
  return 'low';
}

// The band's colour on AURA's tokens; the word beside it carries the meaning.
const BAND_TEXT_CLASS: Record<MatchRateBand, string> = {
  high: 'text-[var(--aura-fg-positive)]',
  medium: 'text-[var(--aura-fg-warning)]',
  low: 'text-[var(--aura-fg-danger)]',
  none: 'text-[var(--aura-fg-secondary)]',
};

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

export function EventsListTable({ rows }: Props) {
  const t = useTranslations('admin.events.list');
  const locale = useLocale();

  const columns = useMemo<DataTableColumn<EventsListTableRow>[]>(
    () => [
      {
        key: 'date',
        label: t('columns.date'),
        ...EVENTS_LIST_COLUMN_LAYOUT.date,
        render: (row) => (
          <span className="text-[var(--aura-fg-secondary)]">
            {formatLocalisedDate(row.startDate, locale, { dateStyle: 'medium' })}
          </span>
        ),
      },
      {
        key: 'name',
        label: t('columns.name'),
        ...EVENTS_LIST_COLUMN_LAYOUT.name,
        render: (row) => (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              href={`/admin/events/${row.eventId}`}
              className="font-medium text-[var(--aura-fg-accent)] underline-offset-4 hover:underline focus-visible:underline"
            >
              {row.name}
            </Link>
            {row.archivedAt !== null ? (
              <Badge variant="outline" tone="neutral">
                {t('badges.archived')}
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        key: 'category',
        label: t('columns.category'),
        ...EVENTS_LIST_COLUMN_LAYOUT.category,
        render: (row) => <span className="text-[var(--aura-fg-secondary)]">{row.category ?? '—'}</span>,
      },
      {
        key: 'registrations',
        label: t('columns.registrations'),
        ...EVENTS_LIST_COLUMN_LAYOUT.registrations,
        render: (row) => <span className="tabular-nums">{row.totalRegistrations.toLocaleString(locale)}</span>,
      },
      {
        key: 'partnerBenefit',
        label: t('columns.partnerBenefit'),
        ...EVENTS_LIST_COLUMN_LAYOUT.partnerBenefit,
        render: (row) =>
          row.isPartnerBenefit || row.isCulturalEvent ? (
            <span className="flex flex-wrap items-center gap-1">
              {row.isPartnerBenefit ? (
                <Badge tone="accent" icon={<Award aria-hidden />}>
                  {t('badges.partnerBenefit')}
                </Badge>
              ) : null}
              {row.isCulturalEvent ? (
                <Badge tone="success" icon={<Sparkles aria-hidden />}>
                  {t('badges.culturalEvent')}
                </Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-[var(--aura-fg-secondary)]">—</span>
          ),
      },
      {
        key: 'matchRate',
        label: t('columns.matchRate'),
        ...EVENTS_LIST_COLUMN_LAYOUT.matchRate,
        render: (row) => {
          const band = bandForPct(row.totalRegistrations, row.matchRatePct);
          if (band === 'none') return <span className="text-[var(--aura-fg-secondary)]">—</span>;
          return (
            <span className="inline-flex flex-col items-end tabular-nums">
              <span className={`font-semibold ${BAND_TEXT_CLASS[band]}`}>
                {`${row.matchRatePct.toFixed(1)}% · ${t(`matchRateBandShort.${band}`)}`}
              </span>
              <span className="aura-text-caption text-[var(--aura-fg-secondary)]">
                {t('matchRateOf', { matched: row.matchedRegistrations, total: row.totalRegistrations })}
              </span>
            </span>
          );
        },
      },
    ],
    [t, locale],
  );

  return (
    <DataTable<EventsListTableRow>
      label={t('tableCaption')}
      rows={rows}
      columns={columns}
      rowKey="eventId"
      manual
      rowHeight="auto"
      stackBelow={640}
      // Edge to edge inside the list card from 640px up; the pager follows.
      bleed
    />
  );
}
