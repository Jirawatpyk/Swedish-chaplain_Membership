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
      {/* The page's frame: the 720px column, centred, back link first (spec 122 US3). */}
      <DetailContainer className="max-w-[calc(45rem+2*var(--page-padding-x))]">
        <SkeletonBlock className="h-5 w-32" />
        <PageHeader
          title={t('pageTitle')}
          subtitle={<SkeletonBlock className="h-4 w-48" />}
        />
        <FormSkeleton fields={5} footerButtons={2} />
      </DetailContainer>
    </PageSkeletonShell>
  );
}
