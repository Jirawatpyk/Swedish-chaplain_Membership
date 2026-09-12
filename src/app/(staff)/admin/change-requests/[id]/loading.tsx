/**
 * Route-level loading UI for /admin/change-requests/[id] — header + a
 * five-row shimmer in the decision table's shape (CLS 0; same container as
 * page.tsx per check:layout).
 */
import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.changeRequests.review');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} actions={<Skeleton className="h-9 w-32" />} />
      <div className="divide-y divide-border rounded-md border" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_5rem] sm:gap-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-5 sm:justify-self-end" />
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-9 w-40" />
      </div>
    </DetailContainer>
  );
}
