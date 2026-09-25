'use client';

/**
 * Task 4 (2026-08-01-broadcast-review-queue-pr2) — `QueueCardList`. Mobile
 * (`< md`) card-stack presentation for the admin review queue (mirrors the
 * renewals precedent, `pipeline-card-list.tsx`).
 *
 * SHARED STATE, NOT A SECOND IMPLEMENTATION — `queue-table-client.tsx`
 * hands this component the SAME `useReactTable` instance it builds for the
 * desktop `<table>` (via the `table` prop), and this component reads rows
 * via `table.getRowModel().rows` + toggles selection via
 * `row.toggleSelected()` — the identical TanStack row API the table's own
 * selection column cell uses. A selection made in card view and one made
 * in table view are therefore the SAME uncontrolled row-selection state;
 * resizing across the `md` breakpoint never loses or duplicates a
 * selection. `ReviewActions` is imported UNCHANGED from `./review-actions`
 * and rendered once per card — same Approve/Reject buttons, same dialogs,
 * each with its own trigger ref (`ReviewActions` already scopes that
 * per-instance, exactly as it does per table row).
 *
 * Card anatomy (fix round 1 — desktop/mobile parity gap: the desktop table's
 * `member` column, rendering who SUBMITTED the broadcast, was missing from
 * the card entirely — an admin couldn't tell whose e-blast they were
 * approving on mobile):
 *   ┌───────────────────────────────────────────┐
 *   │ [ ] Q3 Newsletter               [Awaiting]  │  select checkbox (if actionable+!readOnly) · subject link · status badge
 *   │     Acme Co · Member                        │  memberDisplayName + actorRoleLabel, unlabelled subtitle (no i18n key — mirrors the bare subject)
 *   │ Whose turn  Marketing                       │  F119 T117 — "—" when nobody is waiting
 *   │ Time in stage  [30 h waiting]               │  the SLA badge (stalled / aging) or the plain duration
 *   │ 40 recipients · 37 delivered · …            │  sent rows only (FR-029, UX review H2)
 *   │ ─────────────────────────────────────────  │
 *   │                        [Approve] [Reject]  │  ReviewActions (unchanged), actionable + !readOnly only
 *   └───────────────────────────────────────────┘
 *
 * UX review M7 — exactly the five phone-width fields FR-026 names (member,
 * subject, stage, whose turn, time in stage) plus the delivery line on a sent
 * row. Audience, Recipients and Submitted left the card: they are desktop
 * columns (Audience) or detail-page facts (Submitted), and at phone width
 * every extra line pushes the next card off screen. UX review M6 — the labels
 * are muted, the values are not.
 *
 * The member subtitle mirrors the desktop `member` column cell verbatim
 * (`queue-table-client.tsx:190-204`: bold name stacked over xs-muted role
 * label) and `PipelineCardList`'s tier-under-company-name stacking — an
 * unlabelled subtitle, same as the subject line above it, so no new i18n
 * key was needed.
 *
 * `EnrichedQueueRow` is the parent server component's pre-formatted view
 * model (`queue-table.tsx`) — this list never recomputes a label or date
 * format, so the card and the desktop table can never drift apart.
 *
 * a11y: each card is `<div role="group" aria-label={subject}>` (a `<Card>`
 * under the hood — same convention as `PipelineCardList` /
 * `PortalInvoiceCardList`) inside an `<li>` of a plain `<ul>`. The status
 * badge's visible TEXT (`statusBadgeLabel`) carries the meaning (WCAG
 * 1.4.1), with an sr-only "Status" prefix (`card.statusLabel`) so
 * screen-reader users hear what the badge value describes — the badge
 * itself has no visible label the way a table `<th>` gives its column.
 * The select checkbox reuses the table's OWN `columnLabels.select` i18n
 * key + the `min-h-[24px] min-w-[24px]` sizing (WCAG 2.5.8 AA floor).
 */
import Link from 'next/link';
import type { Table as ReactTableInstance } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ReviewActions } from './review-actions';
import type { EnrichedQueueRow } from './queue-table-client';
import { EmptySentinel, TimeInStage } from './queue-row-cells';

export interface QueueCardListProps {
  /** The SAME `useReactTable` instance `QueueTableClient` builds — see the module docstring. */
  readonly table: ReactTableInstance<EnrichedQueueRow>;
  readonly readOnly: boolean;
  /** Only `select` is consumed here — the rest of `QueueTableClientProps['columnLabels']` is a superset and passes through fine. */
  readonly columnLabels: {
    readonly select: string;
  };
  /** The page passes `md:hidden`. */
  readonly className?: string;
}

export function QueueCardList({
  table,
  readOnly,
  columnLabels,
  className,
}: QueueCardListProps): React.JSX.Element {
  const t = useTranslations('admin.broadcasts.queue.card');
  const rows = table.getRowModel().rows;

  return (
    <div data-testid="queue-card-list" className={className}>
      <ul role="list" className="flex flex-col gap-3">
        {rows.map((row) => {
          const original = row.original;
          const canSelect = row.getCanSelect() && !readOnly;
          const showActions = !readOnly && original.actionable;
          return (
            <li key={row.id}>
              <Card
                role="group"
                aria-label={original.subject}
                data-state={row.getIsSelected() ? 'selected' : undefined}
                className="data-[state=selected]:bg-muted"
              >
                <CardContent className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                      {canSelect ? (
                        <Checkbox
                          checked={row.getIsSelected()}
                          onCheckedChange={() => row.toggleSelected()}
                          aria-label={columnLabels.select}
                          className="mt-1 min-h-[24px] min-w-[24px]"
                        />
                      ) : null}
                      <div className="flex min-w-0 flex-col">
                        <Link
                          href={`/admin/broadcasts/${original.broadcastId}`}
                          className="truncate font-medium text-primary hover:underline"
                        >
                          {original.subject}
                        </Link>
                        {/* Fix round 1 (Important) — who submitted this
                            broadcast, mirroring the desktop `member` column
                            cell (`queue-table-client.tsx:190-204`)
                            verbatim. Unlabelled, like the subject above it —
                            no new i18n key. */}
                        <span className="truncate text-sm text-muted-foreground">
                          {original.memberDisplayName}
                          {original.actorRoleLabel ? ` · ${original.actorRoleLabel}` : ''}
                        </span>
                      </div>
                    </div>
                    <Badge
                      variant={original.statusBadgeVariant}
                      className={cn('shrink-0', original.statusBadgeClassName)}
                    >
                      <span className="sr-only">{t('statusLabel')} </span>
                      {original.statusBadgeLabel}
                    </Badge>
                  </div>
                  {/* F119 T117 (FR-026) — at phone width the card carries
                      whose turn and time in stage beside member, subject and
                      stage; round and the two send times live on the detail
                      page (T115). The SLA badge travels with time in stage. */}
                  <LabeledRow label={t('whoseTurnLabel')}>
                    {original.whoseTurnLabel !== null ? (
                      <span className="text-foreground">{original.whoseTurnLabel}</span>
                    ) : (
                      <EmptySentinel />
                    )}
                  </LabeledRow>
                  <LabeledRow label={t('timeInStageLabel')}>
                    <TimeInStage row={original} />
                  </LabeledRow>
                  {/* FR-029 — delivery results travel with a sent row at
                      every width (UX review H2: the card had dropped them). */}
                  {original.deliverySummary !== null ? (
                    <p className="text-sm tabular-nums">{original.deliverySummary}</p>
                  ) : null}
                  {showActions ? (
                    <div className="flex justify-end">
                      <span className="sr-only">{t('actionsLabel')}</span>
                      <ReviewActions
                        broadcastId={original.broadcastId}
                        recipientCount={original.recipientCount}
                      />
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Same shared-shape helper as `PipelineCardList`'s `LabeledRow` — a `text-sm`
 * `<p>` with an inline label followed by the value node(s). UX review M6 —
 * only the LABEL is muted: a muted value reads as empty or disabled.
 */
function LabeledRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className="text-sm">
      <span data-slot="card-field-label" className="text-muted-foreground">
        {label}
      </span>{' '}
      {children}
    </p>
  );
}
