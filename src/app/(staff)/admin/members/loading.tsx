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
    // Mirror the real page's #7 flex layout (viewport-bounded column, table
    // region flex-fills) so the loading→page swap doesn't shift layout (CLS 0).
    <TableContainer className="h-[calc(100dvh-var(--top-bar-height))] min-h-0 overflow-hidden">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        // Placeholder for the admin-only "Add your first member" CTA
        actions={<Skeleton className="h-9 w-32" />}
      />
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
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
