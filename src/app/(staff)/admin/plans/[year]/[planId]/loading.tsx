/**
 * Route-level loading skeleton for /admin/plans/[year]/[planId].
 *
 * Mirrors the real plan detail page shape 1:1:
 *   - PageHeader: title + subtitle + 2 badge pills + actions (Edit + "⋯",
 *     shown to plans.write holders)
 *   - Fee card: CardTitle + CardDescription + 2-col dl grid (fee, total
 *     incl. VAT, members on the plan, member type)
 *   - Benefit matrix card: CardTitle + the always-present sections (Brand
 *     Visibility 4 rows, Events 3 rows, Additional 3 rows). The Partnership
 *     section only exists for partnership plans, and loading.tsx cannot know
 *     the category, so it is not reserved.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

function KvRowSkeleton() {
  return (
    <div className="flex justify-between border-t border-[var(--aura-border-subtle)] py-1">
      <SkeletonBlock className="h-4 w-32" />
      <SkeletonBlock className="h-4 w-20" />
    </div>
  );
}

function SectionSkeleton({ rows, name }: { rows: number; name: string }) {
  return (
    <section data-skeleton-section={name}>
      <SkeletonBlock className="h-3 w-28 mb-2" />
      <div className="mt-2 flex flex-col">
        {Array.from({ length: rows }).map((_, i) => (
          <KvRowSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}

export default async function Loading() {
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        {/* PageHeader: title + subtitle + 2 badges */}
        <PageHeader
          title={<SkeletonBlock className="h-7 w-56" />}
          subtitle={<SkeletonBlock className="h-4 w-72" />}
          badge={
            <div className="flex gap-2">
              <SkeletonBlock className="h-5 w-20 rounded-full" />
              <SkeletonBlock className="h-5 w-16 rounded-full" />
            </div>
          }
          actions={
            <div className="flex gap-2" data-skeleton="header-actions">
              <SkeletonBlock className="h-9 w-20" />
              <SkeletonBlock className="size-9" />
            </div>
          }
        />

        {/* The fee and benefit-matrix cards, side by side from 1024px
            (board `Admin-plan-detail`; 122 US6 T608). */}
        <div className="grid items-start gap-[var(--aura-space-4)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <Card
            header={
              <div className="space-y-2">
                <SkeletonBlock className="h-5 w-28" />
                <SkeletonBlock className="h-3 w-20" />
              </div>
            }
          >
            <div className="flex flex-col">
              <KvRowSkeleton />
              <KvRowSkeleton />
              <KvRowSkeleton />
              <KvRowSkeleton />
            </div>
          </Card>
          <Card header={<SkeletonBlock className="h-5 w-32" />}>
            <div className="space-y-4">
              {/* Brand Visibility — 4 rows */}
              <SectionSkeleton name="brandVisibility" rows={4} />
              {/* Events — 3 rows */}
              <SectionSkeleton name="events" rows={3} />
              {/* Additional benefits — 3 rows */}
              <SectionSkeleton name="additionalBenefits" rows={3} />
            </div>
          </Card>
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
