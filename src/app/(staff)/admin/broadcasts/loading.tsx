/**
 * Admin /admin/broadcasts loading skeleton.
 *
 * Renders the real PageHeader (static i18n, no broadcast data needed)
 * + body skeletons. Header doesn't flash between skeleton and final
 * state.
 *
 * A4 UX hardening — layout mirrors the real surface so CLS is minimal.
 *
 * Round 4 D11 — that sentence was ahead of the code. The chip COUNT was derived
 * and correct, and the HEIGHT was not: the real bar has a `<legend>` above the
 * chips and a `<Label>` above each of the three controls, none of which the
 * skeleton drew, so the bar grew by about one label line on hydration and the
 * table jumped. Label placeholders added. Still not measured in a browser —
 * "minimal" here means the boxes match, not that CLS was observed.
 *
 * What it mirrors:
 *   - SLA banner placeholder (h-16)
 *   - Filter bar: one chip placeholder per `OFFERED_BROADCAST_STATUSES`
 *     entry + member-select + one date range (matches `queue-filters.tsx`
 *     flex-wrap layout, which renders one chip per OFFERED status — Task 3
 *     fix: this used to hardcode 8, drifting from the 10-entry
 *     `BROADCAST_STATUSES` tuple after the F7.1a Phase 3 B0 extension)
 *
 *     Round 2 R2-23 — and then it drifted the OTHER way: 108 Phase 9 withheld
 *     two retired statuses from the real strip, and this kept reserving 10 for a
 *     row of 8. Both surfaces now read the same derived tuple, so the count
 *     cannot disagree again.
 *
 *     UX review M2 (F119) — with the approval round OFF the strip withholds the
 *     five round-only stages (R18, `APPROVAL_ROUND_ONLY_STATUSES`) unless a row
 *     sits in one, so it renders 8 chips, not 13; the skeleton now reads the
 *     same flag (a synchronous env read) and reserves 8 or 13. A tenant with the
 *     flag off but a row still in a round-only stage renders one or two chips
 *     more than reserved — the rare case, and the chips wrap onto the line the
 *     strip already has.
 *   - The Upcoming sends button (h-9), which the skeleton did not reserve.
 *
 * T086a V3 (PR-1's U12) — below the filter bar it drew seven full-width bars at
 * every width, and the header had no actions. It now mirrors the rebuilt page:
 *   - the header's action row: Templates (only while its flag is on, as the
 *     page decides) and New E-Blast. Below `sm` they share a full-width row
 *     under the title, which the skeleton did not reserve — ~80 px of shift on
 *     every phone load. A manager sees no New E-Blast; the skeleton cannot know
 *     the role, so it reserves the admin's row (the common reader);
 *   - the order hint line above the list;
 *   - from `md`: the seven-column table — a header row and two-line rows (a
 *     value over its secondary line, as every real column renders);
 *   - below `md`: the card list the page renders there instead;
 *   - `aria-busy` on the container, like the other admin loading states.
 * The stalled line is not reserved: it renders only when a shown row stalled.
 *
 * Bulk-action bar is omitted intentionally — it only renders when the
 * admin selects ≥1 row, so reserving space pre-data would itself cause
 * CLS once data lands with zero selections.
 */
import type { CSSProperties } from 'react';
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { QUEUE_ACTIONS_SHARE, QUEUE_COLUMN_LAYOUT } from '@/components/broadcast/admin/queue-table-layout';
import {
  APPROVAL_ROUND_ONLY_STATUSES,
  OFFERED_BROADCAST_STATUSES,
  isEblastMemberApprovalEnabled,
  isF71aUs7Enabled,
} from '@/modules/broadcasts';

/** The table's seven columns (select is the admin's extra, narrow one). */
const QUEUE_COLUMNS = 7;
// The select column, then the page's own column minimums (one module with
// `queue-table-client.tsx`, so the two cannot drift), as grid shares; from
// 1,440 px Actions takes its two and a half shares of the spare width.
const shares = (actionsShare: number): string =>
  [
    '2.5rem',
    ...Object.entries(QUEUE_COLUMN_LAYOUT).map(([key, { minWidth }]) =>
      `${key === 'actions' ? minWidth * actionsShare : minWidth}fr`,
    ),
  ].join(' ');
const QUEUE_GRID_STYLE = {
  '--queue-grid': shares(1),
  '--queue-grid-wide': shares(QUEUE_ACTIONS_SHARE),
} as CSSProperties;
const QUEUE_GRID =
  'grid grid-cols-[var(--queue-grid)] min-[1440px]:grid-cols-[var(--queue-grid-wide)] gap-3 px-6';
const TABLE_ROWS = 6;
const CARDS = 4;

/**
 * Spec 122 US12b — mirrors the AURA page: the header actions, the banner, then
 * one card holding the filter bar (below 640 px only the "Filters" button and
 * Reset; from 640 px the stage chips and the two presets in labelled rows, then
 * the member select and the "Submitted" range), the order hint, the seven-column table
 * from `md` and the board's phone cards below it.
 */
export default async function AdminBroadcastsLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue');
  const approvalRoundEnabled = isEblastMemberApprovalEnabled();
  const chipCount = approvalRoundEnabled
    ? OFFERED_BROADCAST_STATUSES.length
    : OFFERED_BROADCAST_STATUSES.filter((s) => !APPROVAL_ROUND_ONLY_STATUSES.has(s)).length;
  return (
    <TableContainer aria-busy="true">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            {isF71aUs7Enabled() ? (
              <SkeletonBlock data-skeleton="header-action" className="h-9 w-36 max-sm:h-11" aria-hidden="true" />
            ) : null}
            <SkeletonBlock data-skeleton="header-action" className="h-9 w-32 max-sm:h-11" aria-hidden="true" />
          </>
        }
      />
      {/* SLA banner placeholder */}
      <SkeletonBlock className="h-16 w-full" aria-hidden="true" />
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        <div className="flex flex-col gap-[var(--aura-space-4)]" aria-hidden="true">
          {/* Below 640 px the bar is the Filters button. */}
          <SkeletonBlock data-skeleton="filters-button" className="h-11 w-28 sm:hidden" />
          {/* Round 4 D11 — each control keeps its LABEL line, so the bar does
              not grow by a line when the data lands. */}
          <div data-skeleton="filters" className="flex flex-wrap items-end gap-[var(--aura-space-3)] max-sm:hidden">
            {/* The Stage legend, then a labelled row per group: In review,
                Closed, Quick views (the caption on the left from 640 px). */}
            <div className="flex basis-full flex-col gap-3">
              <SkeletonBlock className="h-5 w-16" />
              {[Math.ceil(chipCount / 2), Math.floor(chipCount / 2)].map((n, row) => (
                <div key={row} className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3">
                  <SkeletonBlock className="mt-2 h-4 w-16" />
                  <div className="flex flex-wrap gap-2">
                    {Array.from({ length: n }).map((_, i) => (
                      <SkeletonBlock key={i} data-skeleton="stage-chip" className="h-8 w-24 rounded-full" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="grid basis-full grid-cols-[7rem_minmax(0,1fr)] items-start gap-3">
              <SkeletonBlock className="mt-2 h-4 w-20" />
              <div className="flex flex-wrap gap-2">
                <SkeletonBlock data-skeleton="upcoming-sends" className="h-8 w-40 rounded-full" />
                {/* #400 item 8 — the Waiting on marketing chip, withheld with
                    the round off like the round's stage chips (#400 U2). */}
                {approvalRoundEnabled ? (
                  <SkeletonBlock data-skeleton="waiting-on-marketing" className="h-8 w-52 rounded-full" />
                ) : null}
              </div>
            </div>
            {/* The member select and the one "Submitted" range. */}
            <SkeletonBlock className="h-[var(--aura-input-height)] w-56" />
            <SkeletonBlock data-skeleton="submitted-range" className="h-[var(--aura-input-height)] w-48" />
          </div>
          {/* The order hint above the list. */}
          <SkeletonBlock data-skeleton="order-hint" className="h-4 w-48" />
          {/* From md: the seven-column table — a header row and two-line rows. */}
          <div data-skeleton="queue-table" className="hidden md:block">
            {/* The select column, the seven columns (whose turn sits under the
                Stage pill) and the Actions column, in the page's proportions. */}
            <div className={`${QUEUE_GRID} border-b border-[var(--aura-border-default)] py-3`} style={QUEUE_GRID_STYLE}>
              <span aria-hidden="true" />
              {Array.from({ length: QUEUE_COLUMNS }).map((_, i) => (
                <SkeletonBlock key={i} data-skeleton="queue-column" className="h-4 w-3/4" />
              ))}
            </div>
            {/* UX review L10 — as tall as a real row (88 px: Approve over
                Reject; 68 px from ~1,800 px, where nothing wraps), so the page
                does not move when the rows land. */}
            {Array.from({ length: TABLE_ROWS }).map((_, row) => (
              <div
                key={row}
                data-skeleton="queue-row"
                className={`${QUEUE_GRID} min-h-[5.5rem] min-[1800px]:min-h-[4.25rem] items-center border-b border-[var(--aura-border-default)] py-1.5`}
                style={QUEUE_GRID_STYLE}
              >
                <SkeletonBlock data-skeleton="queue-select" className="size-4 rounded-[var(--aura-radius-xs)]" />
                {Array.from({ length: QUEUE_COLUMNS - 1 }).map((_, i) => (
                  <div key={i} data-skeleton="queue-cell" className="space-y-1.5">
                    <SkeletonBlock className="h-4 w-full" />
                    <SkeletonBlock className="h-3 w-2/3" />
                  </div>
                ))}
                <div data-skeleton="queue-cell" className="flex flex-col gap-1">
                  <span data-skeleton="queue-actions" className="flex flex-col gap-1 min-[1440px]:flex-row min-[1440px]:gap-2">
                    <SkeletonBlock className="h-9 w-24 rounded-full" />
                    <SkeletonBlock className="h-9 w-24 rounded-full" />
                  </span>
                </div>
              </div>
            ))}
          </div>
          {/* Below md: the board's cards — date and chip, subject, member,
              audience, the stage pill, then the full-width Review button. */}
          <div data-skeleton="queue-card-list" className="flex flex-col gap-[var(--aura-space-3)] md:hidden">
            {Array.from({ length: CARDS }).map((_, i) => (
              <div
                key={i}
                data-skeleton="queue-card"
                className="flex flex-col gap-[var(--aura-space-2)] rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] p-[var(--aura-space-4)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <SkeletonBlock className="h-4 w-28" />
                  <SkeletonBlock className="h-5 w-20 rounded-full" />
                </div>
                <SkeletonBlock className="h-5 w-3/4" />
                <SkeletonBlock className="h-4 w-1/2" />
                <SkeletonBlock className="h-4 w-2/3" />
                <SkeletonBlock className="h-5 w-32 rounded-full" />
                <SkeletonBlock className="mt-2 h-11 w-full" />
              </div>
            ))}
          </div>
        </div>
      </Card>
    </TableContainer>
  );
}
