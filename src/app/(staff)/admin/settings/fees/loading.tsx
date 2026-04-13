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
 * Loading matches real <FeeConfigForm>: 3 fields with `space-y-6`,
 * helper note under currency, left-aligned standalone save button.
 */
export default async function Loading() {
  const t = await getTranslations('admin.settings.fees');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <ContentContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          actions={<SkeletonBlock className="h-6 w-20" />}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-[var(--input-height)] w-full" />
                <SkeletonBlock className="h-3 w-64" />
              </div>
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="h-[var(--input-height)] w-full" />
              </div>
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-36" />
                <SkeletonBlock className="h-[var(--input-height)] w-full" />
              </div>
              <SkeletonBlock className="h-9 w-24" />
            </div>
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
