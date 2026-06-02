import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Portal home loading — DetailContainer mirrors the real page.
 */
export default async function Loading() {
  const tShell = await getTranslations('shell');
  const tPortal = await getTranslations('auth.memberPortal');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader
          title={tShell('welcome')}
          subtitle={tPortal('intro')}
          badge={<SkeletonBlock className="h-6 w-40" />}
        />
        <Card>
          <CardHeader>
            <CardTitle>{tPortal('contactHeading')}</CardTitle>
            <CardDescription>{tPortal('contactDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <SkeletonBlock className="h-4 w-48" />
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
