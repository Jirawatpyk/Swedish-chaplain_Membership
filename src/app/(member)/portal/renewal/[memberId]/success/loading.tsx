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
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('portal.renewal.success');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={<SkeletonBlock className="h-4 w-80" />} />
        <Card>
          <CardContent className="flex flex-col gap-3">
            <SkeletonBlock className="h-5 w-40" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-4 w-48" />
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-4 w-48" />
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-4 w-48" />
            </div>
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
