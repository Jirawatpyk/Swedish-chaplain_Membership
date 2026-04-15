/**
 * Route-level loading UI for /admin/members — shimmer skeleton
 * in the final table shape for CLS 0 (ux-standards § 2.1).
 */
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
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.members');
  return (
    <ContentContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardHeader>
          <CardTitle>{t('listHeading')}</CardTitle>
          <CardDescription>{t('refreshHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <MembersTableSkeleton />
        </CardContent>
      </Card>
    </ContentContainer>
  );
}
