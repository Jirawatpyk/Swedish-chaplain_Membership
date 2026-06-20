/**
 * DV-4 — Route-level loading UI for /admin/broadcasts/new.
 *
 * Form-shape skeleton so the transition from the broadcasts queue doesn't
 * flash the parent segment's table-shaped loading.tsx during navigation
 * (FR-007). Mirrors the proxy-compose-form layout: member picker → segment
 * → subject → body → schedule → submit.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.proxySubmitDialog');
  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('pageSubtitle')} />
      <Card>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-24 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-60 w-full" />
          </div>
          <div className="flex justify-end border-t pt-4">
            <Skeleton className="h-9 w-28" />
          </div>
        </CardContent>
      </Card>
    </FormContainer>
  );
}
