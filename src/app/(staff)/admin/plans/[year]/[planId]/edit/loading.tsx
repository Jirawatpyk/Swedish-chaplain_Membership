import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanEditFormSkeleton } from '@/components/plans/plan-edit-form-skeleton';
import { PageSkeletonShell } from '@/components/shell/page-skeletons';

/**
 * Edit renders the flat <PlanEditForm> (not the /plans/new wizard), so the
 * skeleton mirrors that form. Title is generic here ("Edit plan"); the real
 * page swaps in "Edit {planName}" once data resolves. Zero CLS because the
 * h1 box is the same height.
 */
export default async function Loading() {
  const t = await getTranslations('admin.plans');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader title={t('edit.titleGeneric')} />
        <Card>
          <CardContent>
            <PlanEditFormSkeleton />
          </CardContent>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
