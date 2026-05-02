import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';

export default async function EblastsListLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.list');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Skeleton className="h-32 w-full" />
      <div className="space-y-2">
        {/* 10 rows to match `PER_PAGE` in page.tsx — prevents CLS when
            data hydrates (ux-standards.md § 2.1 Skeleton parity). */}
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </DetailContainer>
  );
}
