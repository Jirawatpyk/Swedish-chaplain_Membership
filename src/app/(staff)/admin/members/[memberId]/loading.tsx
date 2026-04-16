/**
 * Route-level loading UI for /admin/members/[memberId] — renders a
 * detail-page-shape skeleton instead of falling back to the directory
 * table skeleton from the parent segment's loading.tsx.
 */
import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { MemberDetailSkeleton } from '@/components/members/member-detail-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.members');
  return (
    <ContentContainer>
      <PageHeader
        title={<Skeleton className="h-8 w-64" />}
        subtitle={t('subtitle')}
        actions={
          <div className="flex gap-2">
            {/* Back to members */}
            <Skeleton className="h-9 w-40" />
            {/* Timeline (US6) */}
            <Skeleton className="h-9 w-28" />
            {/* Edit */}
            <Skeleton className="h-9 w-20" />
          </div>
        }
      />
      <MemberDetailSkeleton />
    </ContentContainer>
  );
}
