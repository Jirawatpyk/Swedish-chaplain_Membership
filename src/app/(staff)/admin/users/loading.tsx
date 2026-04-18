import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
  TableSkeleton,
} from '@/components/shell/page-skeletons';

/**
 * Loading skeleton must mirror the real page layout 1:1 for CLS 0:
 *   - PageHeader with "Invite user" action button (right-aligned)
 *   - Filter bar: search box + role select + status select
 *   - Table (5 cols × 8 rows)
 *   - Pagination summary + nav row
 */
export default async function Loading() {
  const t = await getTranslations('admin.users');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('pageSubtitle')}
          actions={<SkeletonBlock className="h-9 w-28" />}
        />
        <Card>
          <CardContent className="flex flex-col gap-4">
            {/* Filter bar shell — matches <UsersFilters /> shape */}
            <div
              className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4"
              aria-hidden
            >
              <SkeletonBlock className="h-9 flex-1 min-w-0" />
              <SkeletonBlock className="h-9 w-[140px]" />
              <SkeletonBlock className="h-9 w-[140px]" />
            </div>
            <TableSkeleton rows={8} columns={5} />
            {/* Pagination row — "Showing X–Y of Z" + page nav */}
            <div
              className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between"
              aria-hidden
            >
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-9 w-56" />
            </div>
          </CardContent>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
