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
} from '@/components/shell/page-skeletons';

/**
 * Staff dashboard loading state. Everything static renders real;
 * session-dependent subtitle and the list body are skeletons.
 */
export default async function Loading() {
  const tShell = await getTranslations('shell');
  const tLayout = await getTranslations('layout');
  const t = await getTranslations('admin.home');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <ContentContainer>
        <PageHeader
          title={tShell('welcome')}
          subtitle={<SkeletonBlock className="h-4 w-56" />}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('cardTitle')}</CardTitle>
            <CardDescription>{t('cardDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <li key={i} className="flex items-start gap-3">
                  <SkeletonBlock className="size-6 shrink-0 rounded-full" />
                  <SkeletonBlock className="h-5 w-64" />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
