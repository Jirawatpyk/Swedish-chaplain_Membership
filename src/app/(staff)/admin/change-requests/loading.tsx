/**
 * Route-level loading UI for /admin/change-requests — header + the filter
 * bar's shape + five table rows (same TableContainer as page.tsx per
 * check:layout, CLS 0 — the shape is the page's, not a generic list).
 */
import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.changeRequests.queue');
  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <Skeleton className="h-9 w-20" />
      </div>
      <div className="divide-y divide-border rounded-md border" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_5rem_minmax(0,1fr)_6rem_6rem_5rem] sm:items-center sm:gap-4">
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3 w-14" />
            </div>
            <Skeleton className="h-5 w-12" />
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-9 w-20 sm:justify-self-end" />
          </div>
        ))}
      </div>
    </TableContainer>
  );
}
