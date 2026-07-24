/**
 * Route-level loading UI for /admin/members — shimmer skeleton
 * in the final table shape for CLS 0 (ux-standards § 2.1).
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.members');
  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        // Placeholder for the admin-only "Add your first member" CTA
        actions={<Skeleton className="h-9 w-32" />}
      />
      {/* Mirror the real page's #7 sticky-header bound so the skeleton→table
          swap doesn't shift layout (CLS 0). */}
      <Card className="[--table-max-block:max(18rem,calc(100dvh-26rem))]">
        <CardContent className="flex flex-col gap-4">
          {/* Filter bar — matches DirectoryFilters: search + status select + plan select */}
          <FilterBar aria-hidden>
            <Skeleton className="h-9 sm:flex-1" />
            <Skeleton className="h-9 sm:w-36" />
            <Skeleton className="h-9 sm:w-56" />
          </FilterBar>
          <MembersTableSkeleton />
        </CardContent>
      </Card>
    </TableContainer>
  );
}
