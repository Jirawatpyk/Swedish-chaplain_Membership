/**
 * Route-level loading UI for /admin/directory — shimmer skeleton in the final
 * shape for CLS 0 (ux-standards § 2.1). Mirrors the directory layout: header +
 * two generate actions, the Card-wrapped search filter bar + 7-column directory
 * table (via `DirectoryTableSkeleton`), and the recent-exports section. Also
 * provides the Suspense boundary the client `<DirectorySearchFilters>`
 * (`useSearchParams`) needs.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { DirectoryTableSkeleton } from '@/components/directory/directory-table-skeleton';

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

      <Card>
        <CardContent className="flex flex-col gap-4">
          <FilterBar aria-hidden>
            <Skeleton className="h-9 sm:flex-1" />
            {/* "Listed only" — checkbox + label pair (matches DirectorySearchFilters) */}
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded-[4px]" />
              <Skeleton className="h-4 w-24" />
            </div>
          </FilterBar>
          <DirectoryTableSkeleton />
        </CardContent>
      </Card>

      {/* Recent exports — mirrors the populated RecentExports table (3 visible cols)
          so the shell doesn't jump from a single block to a table when data lands. */}
      <section className="space-y-3" aria-hidden>
        <Skeleton className="h-5 w-40" />
        <div className="rounded-md border">
          <div
            className="grid gap-3 border-b bg-muted/40 px-4 py-2"
            style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
          >
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
          </div>
          {[0, 1, 2].map((r) => (
            <div
              key={r}
              className="grid gap-3 border-b px-4 py-3 last:border-b-0"
              style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
            >
              {[0, 1, 2].map((c) => (
                <Skeleton key={c} className="h-4 w-full" />
              ))}
            </div>
          ))}
        </div>
      </section>
    </TableContainer>
  );
}
