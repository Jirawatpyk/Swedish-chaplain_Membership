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
 *   - Filter bar: search + category select + year select + 2 switches
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
        {/* The page's table card: frameless with no padding on a phone. */}
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-4">
            {/* The filter row — matches PlansTable: search, category and year
                selects, 2 switch + label pairs (122 US6 T608). */}
            <div
              aria-hidden
              data-skeleton="filters"
              className="grid grid-cols-2 items-end gap-3 sm:flex sm:flex-wrap"
            >
              <LabelledFieldSkeleton className="col-span-2 min-w-0 sm:min-w-60 sm:flex-1" />
              <LabelledFieldSkeleton className="sm:w-44" />
              <LabelledFieldSkeleton className="sm:w-36" slot="year-select" />
              <div className="col-span-2 flex items-center gap-2 sm:col-auto">
                <SkeletonBlock className="h-5 w-9 rounded-full" />
                <SkeletonBlock className="h-4 w-20" />
              </div>
              <div className="col-span-2 flex items-center gap-2 sm:col-auto">
                <SkeletonBlock className="h-5 w-9 rounded-full" />
                <SkeletonBlock className="h-4 w-24" />
              </div>
            </div>
            <PlanListSkeleton />
            {/* "{total} plans in {year} · fees exclude VAT" caption */}
            <SkeletonBlock className="h-3 w-56" />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}

/** A labelled AURA field's slot: its label line, then the control. */
function LabelledFieldSkeleton({ className, slot }: { readonly className: string; readonly slot?: string }) {
  return (
    <div data-skeleton="labelled-field" className={`flex flex-col gap-1 ${className}`}>
      <SkeletonBlock className="h-4 w-16" />
      <SkeletonBlock className="h-[var(--input-height)] w-full" {...(slot ? { 'data-skeleton': slot } : {})} />
    </div>
  );
}
