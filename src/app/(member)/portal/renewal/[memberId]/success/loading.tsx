/**
 * `/portal/renewal/[memberId]/success` — loading skeleton.
 *
 * Mirrors the real page's `<DetailContainer>` shell + header + details
 * section per `pnpm check:layout` requirement (FR-007 / 006-layout-
 * container-tier2). Container variant matches the page (DetailContainer
 * = 72rem) so CLS-0 holds across the route transition.
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('portal.renewal.success');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <header>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <SkeletonBlock className="mt-2 h-4 w-80" />
        </header>
        <section className="rounded-lg border bg-card p-4">
          <SkeletonBlock className="mb-3 h-5 w-40" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-4 w-48" />
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-4 w-48" />
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-4 w-48" />
          </div>
        </section>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
