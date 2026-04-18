/**
 * Route-level loading UI for /admin/members/new — form-shape skeleton
 * so the transition from the directory doesn't flash the wrong shape
 * (the parent segment's loading.tsx is a table skeleton, which would
 * render during navigation without this override).
 */
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { MemberFormSkeleton } from '@/components/members/member-form-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.members.create');
  return (
    <FormContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={<Skeleton className="h-9 w-20" />}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <MemberFormSkeleton />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
