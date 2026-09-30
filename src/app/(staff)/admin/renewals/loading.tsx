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
 *      a. section tab strip          → STATIC same-footprint shimmer.
 *         NOT the real `<RenewalsSectionTabs>`: that client component calls
 *         `useSearchParams()`, which SUSPENDS when rendered inside a
 *         route-level loading fallback — and a Suspense fallback that itself
 *         suspends cannot paint, so the whole transition stalls (reported
 *         2026-07-31: land on /admin/renewals/tasks, hard-refresh, click the
 *         Renewals tab → navigation frozen on the old page). The page's OWN
 *         Suspense fallback may keep using the real strip (searchParams
 *         context exists there); this file must stay hook-free.
 *      b. work-queue lens strip      → same-footprint shimmer (2 tabs,
 *         `WorkQueueTabs` markup mirrored: mb-3/border-b strip + pt-3
 *         min-h-[320px] panel)
 *      c. filter row + result count + table → shimmer, mirroring
 *         `pipeline-table.tsx` (see the audit note below)
 *   4. By-month year view            → `RenewalsByMonthSectionSkeleton`
 *   5. Members-without-cycle tray    → `MembersWithoutCycleTraySkeleton`
 *
 * Table-portion parity (122 US7a): the pipeline is ONE AURA `DataTable`
 * (`_components/pipeline-table.tsx`) that stacks into cards below 640px, so
 * the shimmer is a grid from `sm` up and a 3-card stack below it — never
 * both lists at once:
 *   - Result-count caption: one text-sm line above the rows.
 *   - Columns: the selection checkbox, 7 data columns and the actions slot
 *     (Send reminder + ⋯, 216px). Rows carry a 44px action shimmer, the
 *     real row's height driver (`touchHeight` buttons).
 *   - Row count: the page requests `limit: 50`, but the shimmer stays
 *     capped at 10 rows (3 cards on a phone) — the swap difference lands
 *     below the fold where it cannot displace what the user is looking at.
 *
 * The three section skeletons are imported from the same modules the page
 * uses as its Suspense fallbacks — single source of truth, so a section
 * redesign updates both surfaces together. (The tab strip is the one
 * deliberate exception — see 3a above.)
 *
 * CLS guarantees that actually hold now:
 *   - Default pipeline view: every section resolves IN PLACE (shimmer →
 *     content, no insertion above the table). All five sections render
 *     unconditionally on this view, so reserving all five never creates
 *     the opposite jump. Known ~20px exception: the money band's prior-FY
 *     sub-line (see `PipelineMoneyBandSkeleton`'s own doc).
 *   - Known 1-line settle on the SUSPENDED tab when the suspended-
 *     population bridge strip is active (#292): the strip renders between
 *     the filter row and the table on `?urgency=suspended` only, and a
 *     route-level loading.tsx receives NO props/searchParams, so it cannot
 *     know the active tab. Reserving the line unconditionally inside the
 *     panel mirror was evaluated and REJECTED — it would misalign the
 *     seven other tabs (including the default t-90, the overwhelmingly
 *     common landing) and the no-bridge Suspended case, trading a rare
 *     1-line settle for a permanent gap everywhere else.
 *   - Alternate returns are NOT mirrored, deliberately: the
 *     `?view=pending-review` discovery view (Card + section tabs only),
 *     the feature-disabled card, and the load-error card all render FEWER
 *     sections — those are rare/secondary paths, and reserving their
 *     shapes here would break the common pipeline case instead.
 *     `PendingReviewSection` therefore gets no reservation.
 *
 * Wrapped in `<TableContainer>` (via the same components the page's
 * `RenewalsPageShell` uses) so the `pnpm check:layout` page+loading
 * same-variant invariant holds. 122 US7a (T709): AURA `Card` and the shell's
 * `SkeletonBlock`, in the page's new order.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PipelineMoneyBandSkeleton } from './_components/pipeline-money-band';
import { RenewalsByMonthSectionSkeleton } from './_components/renewals-by-month-section';
import { MembersWithoutCycleTraySkeleton } from './_components/members-without-cycle-tray';

export default async function Loading() {
  const t = await getTranslations('admin.renewals');
  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <PipelineMoneyBandSkeleton />
      <Card>
        <div className="flex flex-col gap-[var(--aura-space-4)]" aria-hidden>
          {/* Section tabs — a static shimmer the height of the AURA link
              tabs (44px). MUST stay hook-free — see the 3a docstring note
              (the real strip's useSearchParams suspends inside a loading
              fallback and freezes the route transition). */}
          <div className="flex h-11 items-end gap-[var(--aura-space-2)] border-b border-[var(--aura-border-default)] pb-[var(--aura-space-2)]">
            <SkeletonBlock className="h-6 w-20" />
            <SkeletonBlock className="h-6 w-32" />
            <SkeletonBlock className="h-6 w-24" />
            <SkeletonBlock className="h-6 w-28" />
          </div>
          {/* All renewals / Needs action — the segmented control, with the
              help button at the end of the row. */}
          <div className="flex items-center justify-between gap-[var(--aura-space-2)]">
            <SkeletonBlock className="h-9 w-64" />
            <SkeletonBlock className="size-8 rounded-full" />
          </div>
          {/* Panel mirror — the real panel's `min-h-[320px]`. */}
          <div className="flex min-h-[320px] flex-col gap-[var(--aura-space-3)]">
            {/* Filter row: stage chips + tier select; two selects on a phone. */}
            <div className="grid grid-cols-2 items-end gap-[var(--aura-space-3)] sm:flex sm:justify-between">
              <div className="hidden gap-[var(--aura-space-2)] sm:flex">
                {Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonBlock key={i} className="h-9 w-20 shrink-0" />
                ))}
              </div>
              <SkeletonBlock className="h-9 w-full sm:hidden" />
              <SkeletonBlock className="h-9 w-full sm:w-56" />
            </div>
            <div className="flex flex-col gap-[var(--aura-space-2)]">
              {/* Result-count caption. */}
              <SkeletonBlock className="h-5 w-56" />
              {/* From 640px: the grid. */}
              <div className="hidden sm:block">
                <div className="flex h-10 items-center gap-[var(--aura-space-4)] border-b border-[var(--aura-border-default)] px-[var(--aura-space-3)]">
                  <SkeletonBlock className="size-5 shrink-0" />
                  {Array.from({ length: 7 }).map((_, i) => (
                    <SkeletonBlock key={i} className="h-4 flex-1" />
                  ))}
                  <div className="w-54 shrink-0" />
                </div>
                {Array.from({ length: 10 }).map((_, rowIdx) => (
                  <div
                    key={rowIdx}
                    className="flex items-center gap-[var(--aura-space-4)] border-b border-[var(--aura-border-default)] px-[var(--aura-space-3)] py-[var(--aura-space-2)] last:border-b-0"
                  >
                    <SkeletonBlock className="size-5 shrink-0" />
                    {Array.from({ length: 7 }).map((_, colIdx) => (
                      <SkeletonBlock key={colIdx} className="h-5 flex-1" />
                    ))}
                    <SkeletonBlock className="h-11 w-54 shrink-0" />
                  </div>
                ))}
              </div>
              {/* Below 640px: the same table stacked into cards. */}
              <div className="flex flex-col gap-[var(--aura-space-3)] sm:hidden">
                {Array.from({ length: 3 }).map((_, cardIdx) => (
                  <div
                    key={cardIdx}
                    className="flex flex-col gap-[var(--aura-space-3)] rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] p-[var(--aura-space-4)]"
                  >
                    <div className="flex items-start justify-between gap-[var(--aura-space-3)]">
                      <SkeletonBlock className="h-5 w-40" />
                      <SkeletonBlock className="h-6 w-20 shrink-0 rounded-full" />
                    </div>
                    <SkeletonBlock className="h-4 w-3/4" />
                    <SkeletonBlock className="h-4 w-2/3" />
                    <SkeletonBlock className="h-4 w-1/2" />
                    <SkeletonBlock className="h-11 w-full" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Card>
      <RenewalsByMonthSectionSkeleton />
      <MembersWithoutCycleTraySkeleton />
    </TableContainer>
  );
}
