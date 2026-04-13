import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import {
  FormSkeleton,
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Real title uses the generic "Edit plan" key; the real page swaps in
 * "Edit {planName}" once data resolves. Zero CLS because the h1 box is
 * the same height in both states.
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
            <FormSkeleton fields={6} footerButtons={2} withHeader={false} />
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
