import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { ContentContainer } from '@/components/layout/content-container';
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
      <ContentContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('listDescription')}
          actions={
            <div className="flex gap-2">
              <SkeletonBlock className="h-9 w-36" />
              <SkeletonBlock className="h-9 w-28" />
            </div>
          }
        />
        <Card>
          <CardContent className="flex flex-col gap-4">
            {/* Filter bar shell — matches <PlansTable /> filter row */}
            <div
              className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4"
              aria-hidden
            >
              <SkeletonBlock className="h-9 flex-1 min-w-0" />
              <SkeletonBlock className="h-9 w-[180px]" />
              <SkeletonBlock className="h-6 w-28" />
              <SkeletonBlock className="h-6 w-32" />
            </div>
            <PlanListSkeleton />
            {/* "{total} plans in {year}" caption */}
            <SkeletonBlock className="h-3 w-40" />
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
