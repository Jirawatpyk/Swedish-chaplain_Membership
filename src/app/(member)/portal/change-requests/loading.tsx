/**
 * Route-level loading skeleton for `/portal/change-requests` — header + three
 * AURA card rows (spec 122 US3) in the same DetailContainer as page.tsx
 * (check:layout, CLS 0).
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { AuraCardSkeleton } from '@/components/shell/aura-card-skeleton';

export default async function Loading() {
  const t = await getTranslations('portal.changeRequests.history');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="flex flex-col gap-4" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <AuraCardSkeleton
            key={i}
            aria-busy="true"
            title={<SkeletonBlock className="h-5 w-48" />}
            description={<SkeletonBlock className="h-4 w-32" />}
            actions={<SkeletonBlock className="h-6 w-24 rounded-full" />}
          >
            <SkeletonBlock className="h-16 w-full" />
          </AuraCardSkeleton>
        ))}
      </div>
    </DetailContainer>
  );
}
