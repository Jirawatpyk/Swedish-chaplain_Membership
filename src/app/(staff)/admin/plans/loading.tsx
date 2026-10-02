import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanListSkeleton } from '@/components/plans/plan-list-skeleton';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Skeleton mirrors the real /admin/plans page shape for CLS 0:
 *   - PageHeader with two action buttons (Clone + New plan)
 *   - Filter bar: search + Year and Category faces + 2 toggle chips + count
 *   - The table (PlanListSkeleton: AURA's Table, edge to edge in the card)
 *   - Trailing VAT note
 */
export default async function Loading() {
  const t = await getTranslations('admin.plans');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('listDescription')}
          actions={
            <>
              <SkeletonBlock className="h-9 w-28" />
              <SkeletonBlock className="h-9 w-24" />
            </>
          }
        />
        {/* The page's table card: frameless with no padding on a phone. */}
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-4">
            {/* The filter row — matches PlansTable's FilterBar: the search,
                the Year and Category faces, the two toggle chips and the
                count at the end (the filter pattern). */}
            <div aria-hidden data-skeleton="filters" className="flex flex-wrap items-center gap-2">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full sm:w-auto sm:min-w-60 sm:flex-1" />
              <span data-skeleton="year-select" className="contents">
                <SkeletonBlock className="h-[var(--aura-input-height)] w-28" data-skeleton="filter-face" />
              </span>
              <SkeletonBlock className="h-[var(--aura-input-height)] w-36" data-skeleton="filter-face" />
              <SkeletonBlock className="h-8 w-24 rounded-full" data-skeleton="toggle-chip" />
              <SkeletonBlock className="h-8 w-28 rounded-full" data-skeleton="toggle-chip" />
              <SkeletonBlock className="ml-auto h-4 w-20" data-skeleton="result-count" />
            </div>
            {/* AURA's table with the real heads, edge to edge inside the card. */}
            <PlanListSkeleton
              caption={t('tableCaption')}
              heads={[
                t('columns.name'),
                t('columns.category'),
                t('columns.annualFee'),
                t('columns.memberType'),
                t('columns.year'),
                t('columns.status'),
              ]}
            />
            {/* "Fees exclude {rate}% VAT" note */}
            <SkeletonBlock className="h-3 w-56" />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
