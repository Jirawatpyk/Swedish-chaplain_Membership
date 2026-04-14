import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { PlanListSkeleton } from '@/components/plans/plan-list-skeleton';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Renders the real <PageHeader> + <Card> shell (no session/data fetch
 * needed) and the existing <PlanListSkeleton>. Prevents the parent
 * `admin/loading.tsx` from cascading and double-skeletoning the header.
 */
export default async function Loading() {
  const t = await getTranslations('admin.plans');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <ContentContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('listDescription')}
          actions={<SkeletonBlock className="h-9 w-36" />}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('listHeading')}</CardTitle>
            <CardDescription>{t('refreshHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <PlanListSkeleton />
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
