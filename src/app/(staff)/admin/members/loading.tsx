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
import { Skeleton } from '@/components/ui/skeleton';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { MembersTableSkeleton } from '@/components/members/members-table-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.members');
  return (
    <ContentContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        // Placeholder for the admin-only "Add your first member" CTA
        actions={<Skeleton className="h-9 w-44" />}
      />
      <Card>
        <CardHeader>
          <CardTitle>{t('listHeading')}</CardTitle>
          <CardDescription>{t('refreshHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Filter bar shell — search input + checkbox */}
          <div
            className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4"
            aria-hidden
          >
            <Skeleton className="h-9 w-full sm:flex-1" />
            <Skeleton className="h-5 w-32" />
          </div>
          <MembersTableSkeleton />
        </CardContent>
      </Card>
    </ContentContainer>
  );
}
