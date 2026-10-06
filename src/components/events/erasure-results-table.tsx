/**
 * Spec 122 US9b-1 (T925) — the erase-by-email results on AURA `DataTable`
 * (board `Admin-events-erasure`; a card per registration below 640px).
 *
 * Each row: the event (a link, or "Unknown event"), its Bangkok-local date
 * (formatted on the server), the match and quota badges, and the per-row
 * action. FR-032a: a pseudonymised row shows "Already erased" and no erase
 * action — it can never be erased again.
 */
'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, DataTable, type DataTableColumn } from '@jirawatpyk/aura-react';
import type { MatchType } from '@/modules/events';
import { ErasePiiDialog } from './erase-pii-dialog';
import { MatchStatusBadge } from './match-status-badge';
import { QuotaEffectBadge } from './quota-effect-badge';

export interface ErasureResultRow {
  readonly registrationId: string;
  readonly eventId: string;
  readonly eventName: string | null;
  /** Bangkok-local `YYYY-MM-DD`, or null when the event has no start date. */
  readonly dateLabel: string | null;
  readonly attendeeName: string;
  readonly matchType: MatchType;
  readonly quota: 'partnership' | 'cultural' | 'none';
  readonly isPseudonymised: boolean;
}

export const ERASURE_COLUMN_LAYOUT = {
  event: { minWidth: 220, card: 'title' },
  date: { width: 130, card: 'field', cardOrder: 2 },
  match: { width: 170, card: 'pill' },
  quota: { width: 170, card: 'field', cardOrder: 3 },
  actions: { width: 220, align: 'end', card: 'footer', skeletonTouch: true },
} as const satisfies Record<string, Pick<DataTableColumn, 'width' | 'minWidth' | 'card' | 'cardOrder' | 'align' | 'skeletonTouch'>>;

export function ErasureResultsTable({ rows }: { readonly rows: readonly ErasureResultRow[] }) {
  const t = useTranslations('admin.events.erasure');
  const tMatch = useTranslations('admin.events.matchType');
  const tQuota = useTranslations('admin.events.quotaEffect');

  const columns = useMemo<DataTableColumn<ErasureResultRow>[]>(
    () => [
      {
        key: 'event',
        label: t('columns.event'),
        ...ERASURE_COLUMN_LAYOUT.event,
        // On a phone card the title link's tap area grows 12px above and below
        // (at least 44px) through ::after, so the target never pushes the
        // title down the card or away from the field under it.
        render: (r) =>
          r.eventName ? (
            <Link
              href={`/admin/events/${r.eventId}`}
              className="font-medium text-[var(--aura-fg-accent)] underline-offset-2 hover:underline max-sm:relative max-sm:inline-block max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:-inset-y-3 max-sm:after:content-['']"
            >
              {r.eventName}
            </Link>
          ) : (
            <span className="text-[var(--aura-fg-secondary)]">{t('unknownEvent')}</span>
          ),
      },
      {
        key: 'date',
        label: t('columns.date'),
        ...ERASURE_COLUMN_LAYOUT.date,
        render: (r) => <span className="tabular-nums">{r.dateLabel ?? '—'}</span>,
      },
      {
        key: 'match',
        label: t('columns.match'),
        ...ERASURE_COLUMN_LAYOUT.match,
        render: (r) => <MatchStatusBadge matchType={r.matchType} label={tMatch(r.matchType)} />,
      },
      {
        key: 'quota',
        label: t('columns.quota'),
        ...ERASURE_COLUMN_LAYOUT.quota,
        render: (r) =>
          r.quota === 'none' ? (
            <span className="aura-text-caption text-[var(--aura-fg-secondary)]">{tQuota('none')}</span>
          ) : (
            <QuotaEffectBadge kind={r.quota} label={tQuota(r.quota)} />
          ),
      },
      {
        key: 'actions',
        label: t('columns.actions'),
        ...ERASURE_COLUMN_LAYOUT.actions,
        render: (r) =>
          r.isPseudonymised ? (
            <Badge tone="neutral" variant="outline">
              {t('pseudonymisedBadge')}
            </Badge>
          ) : (
            <div className="max-sm:w-full max-sm:[&>button]:flex-1 flex justify-end">
              {/* After a successful erase the row is gone; focus lands on the search. */}
              <ErasePiiDialog
                eventId={r.eventId}
                registrationId={r.registrationId}
                attendeeName={r.attendeeName}
                successFocus={() => document.getElementById('erase-by-email-input')}
              />
            </div>
          ),
      },
    ],
    [t, tMatch, tQuota],
  );

  return (
    <DataTable<ErasureResultRow>
      label={t('tableCaption')}
      rows={[...rows]}
      columns={columns}
      rowKey="registrationId"
      rowHeight="auto"
      stackBelow={640}
      bleed
    />
  );
}
