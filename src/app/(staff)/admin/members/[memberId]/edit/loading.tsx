/**
 * Route-level loading UI for /admin/members/[memberId]/edit — same
 * rationale as /admin/members/new/loading.tsx (form shape, CLS 0).
 */
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FormContainer } from '@/components/layout/form-container';
import { PageHeader } from '@/components/layout/page-header';
import { MemberFormSkeleton } from '@/components/members/member-form-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.members.edit');
  return (
    <FormContainer>
      <PageHeader
        title={t('title')}
        actions={<Skeleton className="h-9 w-20" />}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <Skeleton className="h-5 w-64" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MemberFormSkeleton />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
