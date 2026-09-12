/**
 * Route-level loading UI for /admin/change-requests — header + five list
 * rows (same TableContainer as page.tsx per check:layout, CLS 0).
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
      <div className="divide-y divide-border rounded-md border" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center justify-between px-3 py-3">
            <div className="space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
    </TableContainer>
  );
}
