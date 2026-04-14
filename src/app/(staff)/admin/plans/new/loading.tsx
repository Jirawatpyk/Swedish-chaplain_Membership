import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { PlanFormWizardSkeleton } from '@/components/plans/plan-form-wizard-skeleton';
import { PageSkeletonShell } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.plans.create');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <ContentContainer>
        <PageHeader title={t('title')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <PlanFormWizardSkeleton />
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
