/**
 * Route-level loading skeleton for `/portal/change-requests` — header + three
 * card rows in the same DetailContainer as page.tsx (check:layout, CLS 0).
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default async function Loading() {
  const t = await getTranslations('portal.changeRequests.history');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="flex flex-col gap-4" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <Card key={i} aria-busy="true">
            <CardHeader className="flex flex-row items-start justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-6 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </DetailContainer>
  );
}
