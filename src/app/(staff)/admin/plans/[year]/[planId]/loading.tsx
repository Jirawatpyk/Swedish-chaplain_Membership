/**
 * Route-level loading skeleton for /admin/plans/[year]/[planId].
 *
 * Mirrors the real plan detail page shape 1:1:
 *   - PageHeader: title skeleton + subtitle skeleton + 2 badge pills
 *   - Fee card: CardTitle + CardDescription + 2-col dl grid (2 dt/dd pairs)
 *   - Benefit matrix card: CardTitle + 3 sections (Brand Visibility 4 rows,
 *     Events 3 rows, Partnership 5 rows) separated by hr-style gaps
 */
import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

function DlPairSkeleton() {
  return (
    <div>
      <Skeleton className="h-3 w-24 mb-2" />
      <Skeleton className="h-6 w-32" />
    </div>
  );
}

function KvRowSkeleton() {
  return (
    <div className="flex justify-between border-b border-border/50 py-1">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-20" />
    </div>
  );
}

function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <section>
      <Skeleton className="h-3 w-28 mb-2" />
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
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
      <ContentContainer className="flex flex-col gap-4">
        {/* PageHeader: title + subtitle + 2 badges */}
        <PageHeader
          title={<SkeletonBlock className="h-7 w-56" />}
          subtitle={<SkeletonBlock className="h-4 w-72" />}
          badge={
            <div className="flex gap-2">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          }
        />

        {/* Fee card: title + description + 2-col grid */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Skeleton className="h-5 w-28" />
            </CardTitle>
            <CardDescription>
              <Skeleton className="h-3 w-20" />
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <DlPairSkeleton />
              <DlPairSkeleton />
            </div>
          </CardContent>
        </Card>

        {/* Benefit matrix card: title + 3 sections */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Skeleton className="h-5 w-32" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Brand Visibility — 4 KV rows */}
            <SectionSkeleton rows={4} />
            {/* Events — 3 KV rows */}
            <SectionSkeleton rows={3} />
            {/* Partnership — 5 KV rows */}
            <SectionSkeleton rows={5} />
          </CardContent>
        </Card>
      </ContentContainer>
    </PageSkeletonShell>
  );
}
