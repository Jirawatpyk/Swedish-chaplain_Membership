/**
 * Route-level loading UI for /admin/members — the final table shape for
 * CLS 0 (ux-standards § 2.1). 122 US5a: AURA pulse skeleton. The list card
 * rule (US8a): the filters and the table in one card, frameless below 640px,
 * as the page draws them.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.members');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          // Placeholder for the admin-only header buttons
          actions={<SkeletonBlock className="h-9 w-32" />}
        />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-4">
            {/* Filter bar — matches DirectoryFilters: search + status, plan and
                risk-band selects. */}
            <div className="flex flex-wrap items-center gap-3" aria-hidden>
              <SkeletonBlock className="h-9 min-w-[12rem] flex-1 max-lg:basis-full" />
              <SkeletonBlock className="h-9 w-40" />
              <SkeletonBlock className="h-9 w-56" />
              <SkeletonBlock className="h-9 w-44" />
            </div>
            <MembersTableSkeleton />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
