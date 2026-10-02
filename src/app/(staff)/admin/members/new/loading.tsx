/**
 * Route-level loading UI for /admin/members/new — the form's shape (spec 122
 * US5b-2, board `Admin-member-new`) so the transition from the directory
 * doesn't flash the parent segment's table skeleton. `PageSkeletonShell` is
 * the one live region that announces the load.
 */
import { getTranslations } from 'next-intl/server';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { MemberFormSkeleton } from '@/components/members/member-form-skeleton';
import { FormContainer } from '@/components/layout';
import { MemberFormFrame } from '../_components/member-form-frame';

export default async function Loading() {
  const t = await getTranslations('admin.members.create');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <FormContainer align="start">
        <MemberFormFrame title={t('title')} subtitle={<SkeletonBlock className="h-4 w-72" />}>
          <MemberFormSkeleton />
        </MemberFormFrame>
      </FormContainer>
    </PageSkeletonShell>
  );
}
