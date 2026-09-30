import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanFormWizardSkeleton } from '@/components/plans/plan-form-wizard-skeleton';
import { PageSkeletonShell } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.plans.create');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer className="mx-0">
        <PageHeader title={t('title')} />
        <PlanFormWizardSkeleton />
      </FormContainer>
    </PageSkeletonShell>
  );
}
