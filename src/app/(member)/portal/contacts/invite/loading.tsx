import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
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
      <FormContainer>
        <PageHeader
          title={t('pageTitle')}
          subtitle={<SkeletonBlock className="h-4 w-48" />}
        />
        <FormSkeleton fields={4} footerButtons={1} />
      </FormContainer>
    </PageSkeletonShell>
  );
}
