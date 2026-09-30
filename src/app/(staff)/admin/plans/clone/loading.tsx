import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  FormSkeleton,
  PageSkeletonShell,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.plans.clone');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer className="mx-0">
        <PageHeader title={t('title')} />
        <Card title={t('title')} headingLevel={2}>
          <FormSkeleton fields={4} footerButtons={2} withHeader={false} />
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
