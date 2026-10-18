'use client';

/**
 * `QueueCardList` — the admin review queue below `md`, drawn as board
 * `Admin-broadcasts-mobile` (spec 122 US12b, maintainer 18 Oct):
 *
 *   ┌───────────────────────────────────────────┐
 *   │ 24 Sep 2026, 10:18           [30 h waiting] │  last activity · the SLA chip, else "Time in stage 3 h"
 *   │ Q3 Newsletter                               │  subject (the card's title)
 *   │ Acme Co · Member                            │  member · who submitted it
 *   │ All members · 40 recipients                 │  audience · recipient count
 *   │ [Awaiting marketing review]  Marketing      │  stage pill · whose turn (FR-026, kept on phones)
 *   │ 40 recipients · 37 delivered · …            │  sent rows only (FR-029)
 *   │ [            Review            ]            │  full-width link to the detail page
 *   └───────────────────────────────────────────┘
 *
 * One deviation from the board: the stage pill, whose turn and time in stage
 * stay on the card, because FR-026 names them among the phone-width fields.
 * A stage nobody is waiting on shows neither line.
 *
 * No checkbox and no inline Approve / Reject: bulk approval lives on tablet
 * and desktop, and approve / reject are one tap away on the detail page.
 * `EnrichedQueueRow` is the server's pre-formatted view model
 * (`queue-table.tsx`), so the card never recomputes a label or a date.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { StatusPill, buttonClass } from '@jirawatpyk/aura-react';
import type { EnrichedQueueRow } from './queue-table-client';
import { TimeInStage } from './queue-row-cells';

export interface QueueCardListProps {
  readonly rows: readonly EnrichedQueueRow[];
  /** The page passes `md:hidden`. */
  readonly className?: string;
}

export function QueueCardList({ rows, className }: QueueCardListProps): React.JSX.Element {
  const t = useTranslations('admin.broadcasts.queue.card');

  return (
    <div data-testid="queue-card-list" className={className}>
      <ul role="list" className="flex flex-col gap-[var(--aura-space-3)]">
        {rows.map((row) => (
          <li key={row.broadcastId}>
            <div
              role="group"
              aria-label={row.subject}
              className="flex flex-col gap-[var(--aura-space-2)] rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-[var(--aura-space-4)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-[var(--aura-space-2)]">
                <span className="aura-text-caption text-[var(--aura-fg-secondary)] tabular-nums">
                  {row.lastActivityFormatted}
                </span>
                {row.ageBadge !== null ? (
                  <TimeInStage row={row} />
                ) : row.timeInStageLabel !== null ? (
                  <span className="aura-text-caption">
                    <span className="text-[var(--aura-fg-secondary)]">{t('timeInStageLabel')}</span>{' '}
                    <span className="tabular-nums">{row.timeInStageLabel}</span>
                  </span>
                ) : null}
              </div>
              <p className="aura-text-body font-semibold [overflow-wrap:anywhere]">{row.subject}</p>
              <p className="aura-text-caption text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]">
                {row.memberDisplayName}
                {row.actorRoleLabel ? ` · ${row.actorRoleLabel}` : ''}
              </p>
              <p className="aura-text-caption text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]">
                {row.segmentLabel} · {t('recipients', { count: row.recipientCount })}
              </p>
              <div className="flex flex-wrap items-center gap-[var(--aura-space-2)]">
                <StatusPill tone={row.statusTone}>
                  <span className="sr-only">{t('statusLabel')} </span>
                  {row.statusBadgeLabel}
                </StatusPill>
                {row.whoseTurnLabel !== null ? (
                  <span className="aura-text-caption">
                    <span className="text-[var(--aura-fg-secondary)]">{t('whoseTurnLabel')}</span>{' '}
                    {row.whoseTurnLabel}
                  </span>
                ) : null}
              </div>
              {row.deliverySummary !== null ? (
                <p className="aura-text-caption tabular-nums">{row.deliverySummary}</p>
              ) : null}
              <Link
                href={`/admin/broadcasts/${row.broadcastId}`}
                aria-label={t('reviewAria', { subject: row.subject })}
                className={buttonClass({ variant: 'secondary', fullWidth: true, touchHeight: true, className: 'mt-[var(--aura-space-2)]' })}
              >
                {t('review')}
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
