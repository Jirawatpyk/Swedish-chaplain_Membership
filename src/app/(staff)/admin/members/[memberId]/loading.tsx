/**
 * Route-level loading UI for /admin/members/[memberId] — renders a
 * detail-page-shape skeleton instead of falling back to the directory
 * table skeleton from the parent segment's loading.tsx.
 */
import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { MemberDetailSkeleton } from '@/components/members/member-detail-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.members');
  return (
    <DetailContainer>
      <PageHeader
        title={<Skeleton className="h-8 w-64" />}
        subtitle={t('subtitle')}
        actions={
          <>
            {/* Recent activity (US6 timeline) */}
            <Skeleton className="h-9 w-36" />
            {/* Archive member (US7) — destructive, left of primary */}
            <Skeleton className="h-9 w-36" />
            {/* Edit (primary, rightmost per Fitts's Law) */}
            <Skeleton className="h-9 w-20" />
          </>
        }
      />
      <MemberDetailSkeleton />
    </DetailContainer>
  );
}
