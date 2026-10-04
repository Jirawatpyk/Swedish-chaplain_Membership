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
 *      c. filter row + result count → shimmer; the table → AURA's
 *         `DataTable` in its loading state (see the note below)
 *   4. By-month year view            → `RenewalsByMonthSectionSkeleton`
 *   5. Members-without-cycle tray    → `MembersWithoutCycleTraySkeleton`
 *
 * Table-portion parity (spec 122): the pipeline is ONE AURA `DataTable`
 * (`_components/pipeline-table.tsx`) that stacks into cards below 640px and
 * runs edge to edge inside the card (`bleed`). The skeleton is the same
 * `DataTable` in its loading state, with the columns from
 * `pipeline-table-columns.ts` (keys, sizes, phone-card parts), so it stacks
 * and bleeds the same way. It draws the checkbox column: the route runs
 * before the role is known, and admins, who get the column, are the page's
 * main users (a manager sees one column shift). Below 640px AURA's own
 * stacked cards stand in for the rows; since 5.29 (handoff #134) they keep
 * their field labels and a touch-height footer. It draws 10 rows although the
 * page requests `limit: 50`,
 * so the difference lands below the fold.
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
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PipelineMoneyBandSkeleton } from './_components/pipeline-money-band';
import { RenewalsByMonthSectionSkeleton } from './_components/renewals-by-month-section';
import { MembersWithoutCycleTraySkeleton } from './_components/members-without-cycle-tray';
import { PIPELINE_COLUMN_LAYOUT, type PipelineColumnKey } from './_components/pipeline-table-columns';

const PIPELINE_COLUMN_LABEL_KEYS = {
  tierBucket: 'columns.tier',
  companyName: 'columns.company',
  expiresAt: 'columns.expires',
  urgency: 'columns.urgency',
  lastReminderAt: 'columns.lastReminder',
  status: 'columns.status',
  linkedInvoiceId: 'columns.invoice',
  actions: null,
} as const satisfies Record<PipelineColumnKey, string | null>;

export default async function Loading() {
  const t = await getTranslations('admin.renewals');
  const tTable = await getTranslations('admin.renewals.table');
  const tLayout = await getTranslations('layout');
  const pipelineColumns = (Object.keys(PIPELINE_COLUMN_LAYOUT) as PipelineColumnKey[]).map((key) => ({
    key,
    label: key === 'actions' ? '' : tTable(PIPELINE_COLUMN_LABEL_KEYS[key]),
    ...PIPELINE_COLUMN_LAYOUT[key],
  }));
  return (
    // The one live region that announces the load (AURA's own loading status
    // sits inside the hidden placeholder).
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <PipelineMoneyBandSkeleton />
        {/* The page's work-queue card: frameless with no padding on a phone. */}
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
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
                {/* The pipeline table as the page draws it: AURA's table with the
                    admin's checkbox column, edge to edge; below 640px AURA's own
                    cards, ending in Send reminder at touch height. */}
                <DataTableSkeleton label={tTable('tableCaption')} columns={pipelineColumns} rows={10} selectable />
              </div>
            </div>
          </div>
        </Card>
        <RenewalsByMonthSectionSkeleton />
        <MembersWithoutCycleTraySkeleton />
      </TableContainer>
    </PageSkeletonShell>
  );
}
