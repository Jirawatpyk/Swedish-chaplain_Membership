/**
 * Route-level loading UI for /admin/change-requests — header + the filter
 * bar's shape + five table rows (same TableContainer as page.tsx per
 * check:layout, CLS 0 — the shape is the page's, not a generic list), in
 * the page's one list card (the list card rule, spec 122 US8a).
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.changeRequests.queue');
  const tLayout = await getTranslations('layout');
  return (
    // announced (PR-1 review, UX M4 — the plain aria-hidden skeleton said nothing)
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-4">
            {/* the filter row (the filter pattern): the Status and Submitted
                faces, the count at the end; Outcome exists only under Decided */}
            <div className="flex flex-wrap items-center gap-2" aria-hidden="true" data-skeleton="filters">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-36" data-skeleton="filter-face" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-44" data-skeleton="filter-face" />
              <SkeletonBlock className="ml-auto h-4 w-32" data-skeleton="result-count" />
            </div>
            <div className="divide-y divide-[var(--aura-border-default)] rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)]" aria-hidden="true">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_5rem_minmax(0,1fr)_6rem_6rem_5rem] sm:items-center sm:gap-4">
                  <div className="space-y-1.5">
                    <SkeletonBlock className="h-5 w-40" />
                    <SkeletonBlock className="h-3 w-16" />
                  </div>
                  <div className="space-y-1.5">
                    <SkeletonBlock className="h-5 w-32" />
                    <SkeletonBlock className="h-3 w-14" />
                  </div>
                  <SkeletonBlock className="h-5 w-12" />
                  <SkeletonBlock className="h-5 w-36" />
                  <SkeletonBlock className="h-5 w-16" />
                  <SkeletonBlock className="h-5 w-20" />
                  <SkeletonBlock className="h-9 w-20 sm:justify-self-end" />
                </div>
              ))}
            </div>
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
