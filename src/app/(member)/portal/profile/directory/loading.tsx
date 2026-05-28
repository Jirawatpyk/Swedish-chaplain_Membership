/**
 * Route-level loading UI for /portal/profile/directory — shimmer skeleton in the
 * final shape (ux-standards § 2.1): header, logo block, and the listing settings
 * form (listed toggle + field-visibility checkboxes + metadata inputs).
 */
import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

const FIELD_ROWS = Array.from({ length: 9 }, (_, i) => i);

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('directorySettings');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <div className="space-y-3" aria-hidden>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-20 w-32 rounded border" />
        <Skeleton className="h-9 w-40" />
      </div>

      <div className="space-y-6" aria-hidden>
        <Skeleton className="h-6 w-64" />
        <div className="space-y-2">
          {FIELD_ROWS.map((i) => (
            <Skeleton key={i} className="h-5 w-48" />
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
    </DetailContainer>
  );
}
