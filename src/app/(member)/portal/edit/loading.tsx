import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  FormSkeleton,
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('portal.edit');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      {/* the change-request form's 880px column, as page.tsx draws it */}
      <FormContainer className="max-w-[calc(55rem+2*var(--page-padding-x))]">
        <PageHeader
          title={t('pageTitle')}
          subtitle={<SkeletonBlock className="h-4 w-48" />}
        />
        <FormSkeleton fields={6} footerButtons={1} />
      </FormContainer>
    </PageSkeletonShell>
  );
}
