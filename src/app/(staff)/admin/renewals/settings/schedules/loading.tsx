/**
 * F8 Phase 4 Wave I1b · T086 — Route-level loading skeleton for
 * `/admin/renewals/settings/schedules`. Matches editor shape (5 tab
 * triggers + 3 step-row placeholders) so layout shifts are minimal
 * (CLS=0 per docs/ux-standards.md § 2.1).
 *
 * Wrapped in `<DetailContainer>` so `pnpm check:layout` invariant
 * (page+loading both use the same variant) holds.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.renewals.settings.schedules');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="flex flex-col gap-3" aria-hidden>
        {/* 5-tab placeholder */}
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28" />
          ))}
        </div>
        {/* 3 step-row placeholders */}
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-3 p-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-6 w-32" />
                <div className="flex gap-1">
                  <Skeleton className="h-8 w-8" />
                  <Skeleton className="h-8 w-8" />
                  <Skeleton className="h-8 w-8" />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </DetailContainer>
  );
}
