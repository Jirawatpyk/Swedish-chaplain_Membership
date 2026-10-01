/**
 * `/portal/renewal/[memberId]/success` — loading skeleton.
 *
 * Mirrors the real page's `<DetailContainer>` shell + header + details
 * section per `pnpm check:layout` requirement (FR-007 / 006-layout-
 * container-tier2). Container variant matches the page (DetailContainer
 * = 72rem) so CLS-0 holds across the route transition.
 *
 * Spec 122 US7c: the board's shape — the centred hero, the "Renewal
 * details" AURA card and the action row.
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@jirawatpyk/aura-react/server';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('portal.renewal.success');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[var(--aura-space-6)]">
          <div
            data-testid="renewal-skeleton-hero"
            className="flex flex-col items-center gap-[var(--aura-space-3)] text-center [&_header]:items-center [&_header]:text-center"
          >
            <SkeletonBlock className="size-16 rounded-full" />
            <PageHeader title={t('title')} subtitle={<SkeletonBlock className="h-4 w-64" />} />
          </div>
          <Card header={<SkeletonBlock className="h-6 w-40" />}>
            <div className="grid grid-cols-1 gap-x-[var(--aura-space-4)] gap-y-[var(--aura-space-3)] sm:grid-cols-[auto_1fr]">
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-4 w-44" />
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-6 w-24 rounded-full" />
            </div>
          </Card>
          <div
            data-testid="renewal-skeleton-actions"
            className="flex flex-col gap-[var(--aura-space-2)] sm:flex-row sm:justify-center"
          >
            <SkeletonBlock className="h-9 w-full sm:w-48" />
            <SkeletonBlock className="h-9 w-full sm:w-40" />
          </div>
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
