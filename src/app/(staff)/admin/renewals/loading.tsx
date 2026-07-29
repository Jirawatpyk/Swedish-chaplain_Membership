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
 *      c. filter row + table         → shimmer (8 urgency tabs + tier
 *         select, 8-col header, 10 rows — unchanged from T068)
 *   4. By-month year view            → `RenewalsByMonthSectionSkeleton`
 *   5. Members-without-cycle tray    → `MembersWithoutCycleTraySkeleton`
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
                work-queue tabpanel. */}
            <div className="flex min-h-[320px] flex-col gap-4 pt-3">
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
              {/* Table header placeholder */}
              <div className="grid grid-cols-8 gap-4 border-b py-2" aria-hidden>
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
              {/* 10 row placeholders */}
              {Array.from({ length: 10 }).map((_, rowIdx) => (
                <div
                  key={rowIdx}
                  className="grid grid-cols-8 gap-4 py-2"
                  aria-hidden
                >
                  {Array.from({ length: 8 }).map((_, colIdx) => (
                    <Skeleton key={colIdx} className="h-5 w-full" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
      <RenewalsByMonthSectionSkeleton />
      <MembersWithoutCycleTraySkeleton />
    </TableContainer>
  );
}
