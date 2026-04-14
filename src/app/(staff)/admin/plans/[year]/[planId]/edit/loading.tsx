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
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Edit uses the same <PlanFormWizard> as /plans/new. Title is generic
 * here ("Edit plan"); the real page swaps in "Edit {planName}" once
 * data resolves. Zero CLS because the h1 box is the same height.
 */
export default async function Loading() {
  const t = await getTranslations('admin.plans');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <ContentContainer>
        <PageHeader title={t('edit.titleGeneric')} />
        <Card>
          <CardHeader>
            <CardTitle>
              <SkeletonBlock className="h-6 w-40" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PlanFormWizardSkeleton />
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
