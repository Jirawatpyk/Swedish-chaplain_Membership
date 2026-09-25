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
 *     entry + member-select + 2 date inputs (matches `queue-filters.tsx`
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
 *   - from `md`: the eight-column table — a header row and two-line rows (a
 *     value over its secondary line, as every real column renders);
 *   - below `md`: the card list the page renders there instead;
 *   - `aria-busy` on the container, like the other admin loading states.
 * The stalled line is not reserved: it renders only when a shown row stalled.
 *
 * Bulk-action bar is omitted intentionally — it only renders when the
 * admin selects ≥1 row, so reserving space pre-data would itself cause
 * CLS once data lands with zero selections.
 */
import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import {
  APPROVAL_ROUND_ONLY_STATUSES,
  OFFERED_BROADCAST_STATUSES,
  isEblastMemberApprovalEnabled,
  isF71aUs7Enabled,
} from '@/modules/broadcasts';

/** The table's eight columns (select is the admin's extra, narrow one). */
const QUEUE_COLUMNS = 8;
const TABLE_ROWS = 6;
const CARDS = 4;

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
              <Skeleton data-skeleton="header-action" className="h-9 w-36" aria-hidden="true" />
            ) : null}
            <Skeleton data-skeleton="header-action" className="h-9 w-32" aria-hidden="true" />
          </>
        }
      />
      {/* SLA banner placeholder */}
      <Skeleton className="h-16 w-full" aria-hidden="true" />
      {/* Filter bar: one status chip per OFFERED status + member combobox + date×2 */}
      <div
        className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/20 p-3"
        aria-hidden="true"
      >
        {/*
          Round 4 D11 — each control gets its LABEL line too.
          The real bar renders a `<legend>` above the chip row and a `<Label>`
          above the member select and both date inputs; the skeleton had neither,
          so the bar grew by about one label line the moment data landed and the
          table below it jumped. The docblock on this file already claimed "layout
          mirrors the real surface so CLS is minimal", which made the gap look
          settled — the chip COUNT was fixed and the height was not.
        */}
        <div className="flex flex-col gap-1">
          <Skeleton className="h-5 w-16" />
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: chipCount }).map((_, i) => (
              <Skeleton key={i} data-skeleton="stage-chip" className="h-11 w-24 rounded-full" />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-56" />
        </div>
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-40" />
        </div>
        {/* The Upcoming sends button — no label above it. */}
        <Skeleton data-skeleton="upcoming-sends" className="h-9 w-40" />
        {/* #400 item 8 — the Waiting on marketing button beside it, as wide as
            the button (U6). Withheld with the round off, like the round chips
            above (#400 U2: the strip offers the toggle by R18). */}
        {approvalRoundEnabled ? (
          <Skeleton data-skeleton="waiting-on-marketing" className="h-9 w-52" />
        ) : null}
      </div>
      {/* The order hint (`text-xs`) above the list. */}
      <Skeleton data-skeleton="order-hint" className="h-4 w-48" aria-hidden="true" />
      {/* From md: the eight-column table — an h-10 header row and two-line rows. */}
      <div data-skeleton="queue-table" className="hidden md:block" aria-hidden="true">
        <div className="grid grid-cols-8 gap-3 border-b px-2 py-3">
          {Array.from({ length: QUEUE_COLUMNS }).map((_, i) => (
            <Skeleton key={i} data-skeleton="queue-column" className="h-4 w-3/4" />
          ))}
        </div>
        {Array.from({ length: TABLE_ROWS }).map((_, row) => (
          <div key={row} data-skeleton="queue-row" className="grid grid-cols-8 gap-3 border-b px-2 py-3">
            {Array.from({ length: QUEUE_COLUMNS }).map((_, i) => (
              <div key={i} data-skeleton="queue-cell" className="space-y-1.5">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Below md: the card list — subject + member beside the stage badge,
          the labelled rows, and the actions. */}
      <div data-skeleton="queue-card-list" className="flex flex-col gap-3 md:hidden" aria-hidden="true">
        {Array.from({ length: CARDS }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
                <Skeleton className="h-5 w-20 rounded-4xl" />
              </div>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <div className="flex justify-end">
                <Skeleton className="h-9 w-40" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </TableContainer>
  );
}
