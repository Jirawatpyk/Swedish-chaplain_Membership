import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';
import { env } from '@/lib/env';

/**
 * Staff dashboard loading state. The skeleton MUST mirror the real page's
 * F9-flag fork (see `page.tsx`) — rendering the F1 roadmap skeleton while the
 * live F9 dashboard resolves would cause a layout shift / CLS spike (D6).
 *
 * Scoped inside the `(home)` route group ON PURPOSE: this dashboard-shaped
 * skeleton must be the loading fallback for `/admin` ONLY. If it lived at the
 * `admin/` segment level it would also be the Suspense fallback for the whole
 * admin children slot, so navigating to any /admin/* feature (cache cold) would
 * flash this dashboard skeleton before the target page's own loading.tsx
 * mounts. Do NOT move this back up to `admin/loading.tsx`.
 */
export default async function Loading() {
  const tLayout = await getTranslations('layout');

  if (env.features.f9Dashboard) {
    const t = await getTranslations('admin.dashboard');
    return (
      <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
        <DetailContainer>
          <PageHeader title={t('title')} subtitle={<SkeletonBlock className="h-4 w-56" />} />

          {/* KPI grid — matches `grid gap-4 sm:grid-cols-2 lg:grid-cols-4`. */}
          <div aria-hidden className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <SkeletonBlock className="h-4 w-28" />
                  <SkeletonBlock className="mt-2 h-9 w-20" />
                </CardHeader>
              </Card>
            ))}
          </div>

          {/* Needs-attention + insights — two equal cards. */}
          <div aria-hidden className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i}>
                <CardHeader>
                  <SkeletonBlock className="h-5 w-40" />
                </CardHeader>
                <CardContent className="grid gap-2">
                  {Array.from({ length: 3 }).map((_, j) => (
                    <SkeletonBlock key={j} className="h-5 w-full" />
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Trend charts — two equal cards (summary stat + sparkline), matches
              the real chart row so the activity feed below doesn't shift (CLS). */}
          <div aria-hidden className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <SkeletonBlock className="h-5 w-44" />
                </CardHeader>
                <CardContent>
                  <SkeletonBlock className="h-7 w-28" />
                  <SkeletonBlock className="mt-3 h-24 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Activity feed — full-width card. Header mirrors the real
              ActivityFeed (title + right-aligned Refresh button) to avoid CLS. */}
          <Card aria-hidden>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <SkeletonBlock className="h-5 w-40" />
              <SkeletonBlock className="h-8 w-20 rounded-md" />
            </CardHeader>
            <CardContent className="grid gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonBlock key={i} className="h-5 w-full" />
              ))}
            </CardContent>
          </Card>
        </DetailContainer>
      </PageSkeletonShell>
    );
  }

  // F9 off — the F1 placeholder roadmap skeleton.
  const tShell = await getTranslations('shell');
  const t = await getTranslations('admin.home');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader
          title={tShell('welcome')}
          subtitle={<SkeletonBlock className="h-4 w-56" />}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('cardTitle')}</CardTitle>
            <CardDescription>{t('cardDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <li key={i} className="flex items-start gap-3">
                  <SkeletonBlock className="size-6 shrink-0 rounded-full" />
                  <SkeletonBlock className="h-5 w-64" />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
