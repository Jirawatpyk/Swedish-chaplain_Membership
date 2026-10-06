/**
 * F6 Phase 10 T112 — erase-PII page skeleton. Spec 122 US9b-1 (T926): the
 * page's shape on AURA — the header, then the one card with the hint, the
 * erase trigger and the way back.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function ErasePiiLoading() {
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer aria-busy="true">
        <PageHeader
          title={
            <span aria-hidden="true" className="block">
              <SkeletonBlock className="h-7 w-96 max-w-full" />
            </span>
          }
        />
        <Card aria-hidden>
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            <SkeletonBlock className="h-4 w-full max-w-xl" />
            <div className="flex flex-wrap gap-[var(--aura-space-3)]">
              <SkeletonBlock className="h-8 w-32 max-sm:h-11 max-sm:w-full" />
              <SkeletonBlock className="h-8 w-44 max-sm:h-11 max-sm:w-full" />
            </div>
          </div>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
