/**
 * Route-level loading skeleton for `/portal/change-requests` — header + three
 * AURA card rows (spec 122 US3) in the same DetailContainer as page.tsx
 * (check:layout, CLS 0).
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('portal.changeRequests.history');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="flex flex-col gap-4" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="aura-card" aria-busy="true">
            <div className="aura-card__head">
              <div className="aura-card__heading gap-2">
                <SkeletonBlock className="h-5 w-48" />
                <SkeletonBlock className="h-4 w-32" />
              </div>
              <SkeletonBlock className="h-6 w-24 rounded-full" />
            </div>
            <div className="aura-card__body">
              <SkeletonBlock className="h-16 w-full" />
            </div>
          </div>
        ))}
      </div>
    </DetailContainer>
  );
}
