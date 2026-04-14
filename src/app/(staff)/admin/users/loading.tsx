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
  PageSkeletonShell,
  SkeletonBlock,
  TableSkeleton,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.users');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <ContentContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('pageSubtitle')}
          actions={<SkeletonBlock className="h-6 w-24" />}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('listHeading')}</CardTitle>
            <CardDescription>{t('listDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <TableSkeleton rows={8} columns={5} />
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
