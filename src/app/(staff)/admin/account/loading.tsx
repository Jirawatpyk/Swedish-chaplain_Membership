import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ChangePasswordFormSkeleton } from '@/components/auth/change-password-form-skeleton';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('auth.changePassword');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <ContentContainer>
        <PageHeader
          title={t('title')}
          subtitle={<SkeletonBlock className="h-4 w-56" />}
          badge={<SkeletonBlock className="h-6 w-20" />}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('title')}</CardTitle>
            <CardDescription>{t('description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ChangePasswordFormSkeleton />
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
