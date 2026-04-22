import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/ui/filter-bar';
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
 *   - Filter bar: search + category select + 2 switches
 *   - Border-wrapped table (PlanListSkeleton)
 *   - Trailing total-count line
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
        <Card>
          <CardContent className="flex flex-col gap-4">
            {/* Filter bar — matches PlansTable: search (with icon space)
                + category select + 2 switch+label pairs */}
            <FilterBar aria-hidden>
              {/* Search with 🔍 icon indent */}
              <SkeletonBlock className="h-9 min-w-0 sm:flex-1" />
              {/* Category select */}
              <SkeletonBlock className="h-9 sm:w-[180px]" />
              {/* Active only: switch (h-5 w-9) + label */}
              <div className="flex items-center gap-2">
                <SkeletonBlock className="h-5 w-9 rounded-full" />
                <SkeletonBlock className="h-4 w-20" />
              </div>
              {/* Show deleted: switch + label */}
              <div className="flex items-center gap-2">
                <SkeletonBlock className="h-5 w-9 rounded-full" />
                <SkeletonBlock className="h-4 w-24" />
              </div>
            </FilterBar>
            <PlanListSkeleton />
            {/* "{total} plans in {year}" caption */}
            <SkeletonBlock className="h-3 w-40" />
          </CardContent>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
