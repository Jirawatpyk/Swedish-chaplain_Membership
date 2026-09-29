/**
 * Route-level loading UI for /admin/members/[memberId] — the detail page's
 * shape (spec 122 US5b-1, board `Admin-member-detail`): the chips above the
 * name, the header actions, then the body skeleton. `PageSkeletonShell` is the
 * one live region that announces the load.
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { MemberDetailSkeleton } from '@/components/members/member-detail-skeleton';

export default async function Loading() {
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer aria-busy="true">
        <PageHeader
          title={<SkeletonBlock className="h-8 w-64" />}
          eyebrow={
            <>
              <SkeletonBlock className="h-6 w-20" />
              <SkeletonBlock className="h-6 w-24" />
            </>
          }
          subtitle={<SkeletonBlock className="h-4 w-48" />}
          actions={
            <>
              <SkeletonBlock className="h-9 w-28" />
              <SkeletonBlock className="h-9 w-36" />
              <SkeletonBlock className="h-9 w-20" />
            </>
          }
        />
        <MemberDetailSkeleton />
      </DetailContainer>
    </PageSkeletonShell>
  );
}
