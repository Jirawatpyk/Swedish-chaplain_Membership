import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
      <FormContainer>
        <PageHeader title={t('title')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <FormSkeleton fields={4} footerButtons={2} withHeader={false} />
          </CardContent>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
