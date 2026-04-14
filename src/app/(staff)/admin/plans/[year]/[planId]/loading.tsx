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
import {
  CardSkeleton,
  DetailSkeleton,
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.plans');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <ContentContainer>
        <PageHeader
          title={t('detail.titleGeneric')}
          subtitle={<SkeletonBlock className="h-4 w-72" />}
          badge={
            <div className="flex gap-2">
              <SkeletonBlock className="h-6 w-20" />
              <SkeletonBlock className="h-6 w-16" />
            </div>
          }
        />
        <Card>
          <CardHeader>
            <CardTitle>
              <SkeletonBlock className="h-6 w-32" />
            </CardTitle>
            <CardDescription>
              <SkeletonBlock className="h-4 w-24" />
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DetailSkeleton items={4} columns={2} />
          </CardContent>
        </Card>
        <CardSkeleton rows={6} />
      </ContentContainer>
    </PageSkeletonShell>
  );
}
