import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';
import { StatSkeleton } from './_components/membership-stat-section';
import { RecentActivitySkeleton } from './_components/recent-activity-section';

/**
 * Portal dashboard loading skeleton (057 redesign).
 *
 * Shape mirrors the real page.tsx exactly so there is no CLS when
 * React replaces this with the streamed content:
 *   PageHeader (welcome chip row)
 *   → 3 stat cards (1-col mobile / 3-up sm+)
 *   → 2-col panel (invoices | benefits, stacks to 1-col on mobile)
 *   → recent-activity card
 *
 * All skeleton sizes are derived from the real component tokens
 * (CardContent padding, StatCard h-7 value, Skeleton h-10 activity rows)
 * so the layout transition is pixel-stable.
 */
export default async function Loading() {
  const t = await getTranslations('portal.dashboard');
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        {/* PageHeader: welcome text + badge chips placeholder */}
        <PageHeader
          title={t('welcome', { name: '' })}
          subtitle={t('intro')}
          badge={<SkeletonBlock className="h-6 w-44" />}
        />

        {/* 3 stat cards — 1-col mobile, 3-up sm+ */}
        <div className="grid grid-cols-1 gap-[var(--page-section-gap)] sm:grid-cols-3">
          <StatSkeleton />
          <StatSkeleton />
          <StatSkeleton />
        </div>

        {/* 2-col: invoices summary | benefits quota */}
        <div className="grid grid-cols-1 gap-[var(--page-section-gap)] lg:grid-cols-2">
          {/* Invoices summary card skeleton */}
          <Card aria-busy="true" aria-hidden="true">
            <CardHeader className="pb-2">
              <SkeletonBlock className="h-5 w-36" />
              <SkeletonBlock className="mt-1 h-3 w-56" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <SkeletonBlock key={i} className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>

          {/* Benefits quota card skeleton */}
          <Card aria-busy="true" aria-hidden="true">
            <CardHeader className="pb-2">
              <SkeletonBlock className="h-5 w-32" />
              <SkeletonBlock className="mt-1 h-3 w-48" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonBlock key={i} className="h-4 w-full" />
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Recent-activity card */}
        <RecentActivitySkeleton />
      </DetailContainer>
    </PageSkeletonShell>
  );
}
