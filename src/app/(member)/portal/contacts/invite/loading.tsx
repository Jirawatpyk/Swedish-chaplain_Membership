import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  FormSkeleton,
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('portal.invite');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      {/* The page's frame: back link, then a 720px column (spec 122 US3). */}
      <DetailContainer>
        <SkeletonBlock className="h-5 w-32" />
        <div className="flex max-w-[720px] flex-col gap-[var(--page-section-gap)]">
          <PageHeader
            title={t('pageTitle')}
            subtitle={<SkeletonBlock className="h-4 w-48" />}
          />
          <FormSkeleton fields={5} footerButtons={2} />
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
