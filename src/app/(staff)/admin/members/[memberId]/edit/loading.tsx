/**
 * Route-level loading UI for /admin/members/[memberId]/edit — same rationale
 * as /admin/members/new/loading.tsx (the form's shape, CLS 0; spec 122
 * US5b-2, board `Admin-member-edit`: the notification-language card first).
 */
import { getTranslations } from 'next-intl/server';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { MemberFormSkeleton } from '@/components/members/member-form-skeleton';
import { MemberFormFrame } from '../../_components/member-form-frame';

export default async function Loading() {
  const t = await getTranslations('admin.members.edit');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <MemberFormFrame title={t('title')} subtitle={<SkeletonBlock className="h-4 w-56" />}>
        <MemberFormSkeleton withLocaleCard />
      </MemberFormFrame>
    </PageSkeletonShell>
  );
}
