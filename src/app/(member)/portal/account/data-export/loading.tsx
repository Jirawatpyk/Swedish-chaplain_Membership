/**
 * Route-level loading UI for /portal/account/data-export — shimmer skeleton in
 * the final shape (ux-standards § 2.1, staff-review I2/B2): header + description,
 * the request button, and the recent-requests table (status + requested + action).
 */
import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

const ROWS = Array.from({ length: 3 }, (_, i) => i);

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('dataExport');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Skeleton className="h-4 w-full max-w-prose" aria-hidden />
      <div className="space-y-6" aria-hidden>
        <Skeleton className="h-9 w-48" />
        <div className="space-y-3">
          <Skeleton className="h-5 w-32" />
          <div className="space-y-2">
            {ROWS.map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </div>
      </div>
    </DetailContainer>
  );
}
