/**
 * Route-level loading UI for /admin/directory — shimmer skeleton in the final
 * shape for CLS 0 (ux-standards § 2.1). Mirrors the directory layout: header +
 * two generate actions, the search filter bar, a 7-column directory table, and
 * the recent-exports section. Also provides the Suspense boundary the client
 * `<DirectorySearchFilters>` (`useSearchParams`) needs.
 */
import { getTranslations } from 'next-intl/server';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

const ROWS = Array.from({ length: 8 }, (_, i) => i);

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.directory');
  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex gap-2">
            <Skeleton className="h-9 w-40" />
            <Skeleton className="h-9 w-36" />
          </div>
        }
      />

      <FilterBar aria-hidden>
        <Skeleton className="h-9 sm:w-72" />
        <Skeleton className="h-5 w-32" />
      </FilterBar>

      <div className="overflow-x-auto rounded-md border" aria-hidden>
        <div className="min-w-full divide-y">
          <div className="flex gap-4 p-3">
            {['w-40', 'w-28', 'w-32', 'w-28', 'w-16', 'w-16', 'w-32'].map((w, i) => (
              <Skeleton key={`${w}-${i}`} className={`h-4 ${w}`} />
            ))}
          </div>
          {ROWS.map((i) => (
            <div key={i} className="flex gap-4 p-3">
              <Skeleton className="h-9 w-40" />
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-32" />
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-16" />
              <Skeleton className="h-9 w-16" />
              <Skeleton className="h-9 w-32" />
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
    </TableContainer>
  );
}
