/**
 * Route-level loading UI for /admin/invoices.
 *
 * async + translated title/subtitle match the pattern used by members,
 * plans, and settings/invoicing. An older sync version was observed to
 * bubble up to the parent /admin/loading.tsx (dashboard skeleton) under
 * Next.js 16 Cache Components because the boundary did not resolve
 * its i18n in time with the async page.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.invoices.list');
  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        actions={<Skeleton className="h-9 w-32" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Filter bar skeleton — mirrors <InvoiceFilters /> */}
          <FilterBar aria-hidden>
            <Skeleton className="h-9 min-w-0 sm:flex-1" />
            <Skeleton className="h-9 sm:w-[12rem]" />
          </FilterBar>
          {/* Table rows skeleton */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
          {/* Pagination summary skeleton */}
          <div className="flex justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-9 w-48" />
          </div>
        </CardContent>
      </Card>
    </TableContainer>
  );
}
