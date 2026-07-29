/**
 * Route-level loading skeleton for `/admin/renewals`.
 *
 * renewals-loading-skeleton-parity — rebuilt from the stale F8 Phase 3
 * (T068) version, which was written when the page was header + table only
 * and still claimed "CLS=0" long after the page had grown four more
 * sections: on navigation it painted a lone table card, then the resolved
 * page inserted the money band / section tabs / by-month chart / tray
 * around it and everything jumped. This file now mirrors the REAL page's
 * default-view section order (page.tsx main return, top to bottom):
 *
 *   1. `PageHeader` (real text — no data dependency)
 *   2. THB money KPI band            → `PipelineMoneyBandSkeleton`
 *   3. Work-queue Card:
 *      a. section tab strip          → real `<RenewalsSectionTabs showPipelineHelp />`
 *         (the page's own Suspense fallback — labels are static i18n)
 *      b. work-queue lens strip      → same-footprint shimmer (2 tabs,
 *         `WorkQueueTabs` markup mirrored: mb-3/border-b strip + pt-3
 *         min-h-[320px] panel)
 *      c. filter row + result count + table/card-stack → shimmer, mirroring
 *         `pipeline-table.tsx` + `pipeline-card-list.tsx` (see the audit
 *         note below)
 *   4. By-month year view            → `RenewalsByMonthSectionSkeleton`
 *   5. Members-without-cycle tray    → `MembersWithoutCycleTraySkeleton`
 *
 * Table-portion parity audit (renewals-loading-skeleton-parity follow-up) —
 * MIRROR SOURCE: `_components/pipeline-table.tsx` (desktop `<table>`,
 * `hidden md:block`) + `_components/pipeline-card-list.tsx` (mobile
 * card-stack, `md:hidden`). What the T068 block got wrong and how this
 * version tracks the real thing:
 *   - Result-count caption: `PipelineTable` renders `ResultCountLabel` (one
 *     text-sm line) above the rows inside its own `gap-2` block — T068
 *     reserved nothing, so the caption inserted above the table on swap.
 *   - Columns: 9 on desktop for the common admin case (selection checkbox +
 *     7 data columns + ⋯ actions), not 8 equal — the narrow checkbox (24px
 *     visible box) and actions slots are sized, the 7 data columns stay
 *     equal-width shimmer.
 *   - Row height: rows reuse the REAL geometry classes
 *     (`px/py-[var(--table-cell-padding-*)]`, header
 *     `h-[var(--table-row-height)]` — same tokens as the shared
 *     `TableSkeleton` in `page-skeletons.tsx`) and each body row carries an
 *     h-11 actions shimmer because the real row's height driver is the 44px
 *     ⋯ trigger (`row-actions.tsx` `h-11 w-11`): 44px content + 2×8px cell
 *     padding ≈ 60px/row, not T068's ~36px (which under-reserved ~240px
 *     over 10 rows).
 *   - Responsive: the grid is now `hidden md:block`; below `md` a 3-card
 *     stack mirrors `PipelineCardList`'s anatomy (name+tier / urgency pill
 *     header row, three labelled value lines, ⋯ actions row) — T068 showed
 *     the 8-col grid on phones where no table exists.
 *   - Row count: the page requests `limit: 50`, but the shimmer stays
 *     capped at 10 rows (3 cards on mobile) — 50 shimmer rows would bloat
 *     the DOM and over-reserve far past the viewport; the swap difference
 *     lands below the fold where it cannot displace what the user is
 *     looking at.
 *
 * The three section skeletons + the tab strip are imported from the same
 * modules the page uses as its Suspense fallbacks — single source of truth,
 * so a section redesign updates both surfaces together.
 *
 * CLS guarantees that actually hold now:
 *   - Default pipeline view: every section resolves IN PLACE (shimmer →
 *     content, no insertion above the table). All five sections render
 *     unconditionally on this view, so reserving all five never creates
 *     the opposite jump. Known ~20px exception: the money band's prior-FY
 *     sub-line (see `PipelineMoneyBandSkeleton`'s own doc).
 *   - Alternate returns are NOT mirrored, deliberately: the
 *     `?view=pending-review` discovery view (Card + section tabs only),
 *     the feature-disabled card, and the load-error card all render FEWER
 *     sections — those are rare/secondary paths, and reserving their
 *     shapes here would break the common pipeline case instead.
 *     `PendingReviewSection` therefore gets no reservation.
 *
 * Wrapped in `<TableContainer>` (via the same components the page's
 * `RenewalsPageShell` uses) so the `pnpm check:layout` page+loading
 * same-variant invariant holds.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PipelineMoneyBandSkeleton } from './_components/pipeline-money-band';
import { RenewalsSectionTabs } from './_components/renewals-section-tabs';
import { RenewalsByMonthSectionSkeleton } from './_components/renewals-by-month-section';
import { MembersWithoutCycleTraySkeleton } from './_components/members-without-cycle-tray';

export default async function Loading() {
  const t = await getTranslations('admin.renewals');
  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <PipelineMoneyBandSkeleton />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <RenewalsSectionTabs showPipelineHelp />
          <div>
            {/* Work-queue lens strip (Pipeline | Needs action) — mirrors
                `WorkQueueTabs`' tablist wrapper + `px-3 py-1.5` tab height
                (~h-8) so the real strip swaps in without moving the filter
                row below it. */}
            <div className="mb-3 flex flex-wrap gap-1 border-b" aria-hidden>
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-28" />
            </div>
            {/* Panel mirror — same `pt-3 min-h-[320px]` as the real
                work-queue tabpanel; `gap-3` matches the pipeline lens's own
                `flex flex-col gap-3` root (page.tsx). */}
            <div className="flex min-h-[320px] flex-col gap-3 pt-3">
              {/* Filter row — 8 urgency tabs + tier filter select. Stacks on
                  mobile, row on sm+. (Unchanged from the T068 skeleton.) */}
              <div
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                aria-hidden
              >
                <div className="flex gap-1.5 overflow-x-auto">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-20 shrink-0" />
                  ))}
                </div>
                <Skeleton className="h-9 w-full sm:w-56" />
              </div>
              {/* PipelineTable mirror — its root is `flex flex-col gap-2`:
                  result-count caption, then the responsive table/card-stack
                  pair. See the module docstring's parity-audit note. */}
              <div className="flex flex-col gap-2" aria-hidden>
                {/* Result-count caption (`ResultCountLabel`, one text-sm line). */}
                <Skeleton className="h-5 w-56" />
                {/* Desktop ≥md — 9-column grid: 24px selection checkbox +
                    7 equal data columns + the ⋯ actions slot. Header reuses
                    `h-[var(--table-row-height)]`; body rows reuse the real
                    cell-padding tokens, and the h-11 actions bar reproduces
                    the real row-height driver (44px ⋯ trigger → ~60px/row). */}
                <div className="hidden md:block">
                  <div className="flex h-[var(--table-row-height)] items-center gap-4 border-b px-[var(--table-cell-padding-x)]">
                    <Skeleton className="size-6 shrink-0" />
                    {Array.from({ length: 7 }).map((_, i) => (
                      <Skeleton key={i} className="h-4 flex-1" />
                    ))}
                    <div className="w-11 shrink-0" />
                  </div>
                  {Array.from({ length: 10 }).map((_, rowIdx) => (
                    <div
                      key={rowIdx}
                      className="flex items-center gap-4 border-b px-[var(--table-cell-padding-x)] py-[var(--table-cell-padding-y)] last:border-b-0"
                    >
                      <Skeleton className="size-6 shrink-0" />
                      {Array.from({ length: 7 }).map((_, colIdx) => (
                        <Skeleton key={colIdx} className="h-5 flex-1" />
                      ))}
                      <Skeleton className="h-11 w-11 shrink-0" />
                    </div>
                  ))}
                </div>
                {/* Mobile <md — card-stack mirror of `PipelineCardList`
                    (`ul` gap-3; card = name+tier / urgency-pill header row,
                    labelled value lines, ⋯ actions row). 3 cards ≈ one
                    phone viewport. */}
                <div className="flex flex-col gap-3 md:hidden">
                  {Array.from({ length: 3 }).map((_, cardIdx) => (
                    <Card key={cardIdx}>
                      <CardContent className="flex flex-col gap-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-col gap-1">
                            <Skeleton className="h-5 w-40" />
                            <Skeleton className="h-4 w-24" />
                          </div>
                          <Skeleton className="h-6 w-16 shrink-0 rounded-full" />
                        </div>
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-4 w-1/2" />
                        <div className="flex justify-end">
                          <Skeleton className="h-11 w-28" />
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      <RenewalsByMonthSectionSkeleton />
      <MembersWithoutCycleTraySkeleton />
    </TableContainer>
  );
}
