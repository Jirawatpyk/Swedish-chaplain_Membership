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
 *
 * 016 T054 — this skeleton does NOT mirror the finance/engagement split, on
 * purpose. Doing so would need the viewer's permissions, and the only way to
 * get them here is `getCurrentSession()`, which is not React-cached and writes
 * `last_seen_at` — i.e. a DB write on every loading fallback.
 *
 * What a viewer without `insights.finance` actually sees, stated honestly
 * (the first version of this note claimed the shift was nil, which is true only
 * at `lg` and above, and it counted one collapsing chart row when there are
 * two):
 *
 *  - KPI row: 4 placeholders settle into 3.
 *  - The two chart ROWS (Trends + Breakdown, 2 cards each) settle into ONE
 *    "Engagement charts" row of 2 cards — so one whole row disappears.
 *
 * The KPI change is a horizontal reflow at every breakpoint. The chart change
 * is not: one row of cards is removed outright, so that viewer scores CLS at
 * every width, not only below `lg`. An earlier version of this note described a
 * 2→1 settle in each of two rows — that was true for about an hour, until the
 * same commit merged them, and it is recorded here because a note that drifts
 * from the layout it describes is how the next reader is misled. Accepted: the affected population is `marketing` only, staff work
 * here is desktop-first, and the alternative is a DB write on every fallback.
 *
 * Revisit if either changes: `getCurrentSession` becoming side-effect-free and
 * request-cached, or the page moving its data reads behind their own
 * `<Suspense>` boundaries — the latter would let the shell stream with
 * `canFinance` already known and make this file's fork unnecessary.
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

          {/* Breakdown charts (Task 12) — membership-by-tier bar + invoice-
              status donut. Distinct shapes (rectangular bar block vs. a
              circular donut block + a reserved legend line) so the skeleton
              reads as "two different chart types" rather than two identical
              placeholders, matching the real Breakdown section below. */}
          <div aria-hidden className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <SkeletonBlock className="h-5 w-40" />
              </CardHeader>
              <CardContent>
                {/* Headline row (text-3xl active total + right-aligned caption)
                    — mirrors MembershipTierChart's summary row so the
                    skeleton→real swap doesn't insert a new line and push the
                    bars (and the activity feed below) down (CLS). */}
                <div className="flex items-baseline justify-between gap-2">
                  <SkeletonBlock className="h-8 w-16" />
                  <SkeletonBlock className="h-3 w-24" />
                </div>
                {/* Bar area reserves MembershipTierChart's MIN_CHART_HEIGHT_PX
                    (120px). The real canvas grows 36px per tier above 3 tiers,
                    so many-tier tenants expand DOWNWARD from here — a skeleton
                    cannot know the tier count before the snapshot resolves. */}
                <SkeletonBlock className="mt-3 h-[120px] w-full" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <SkeletonBlock className="h-5 w-40" />
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3">
                <SkeletonBlock className="h-40 w-40 rounded-full" />
                {/* Reserves the visible legend row's height (WCAG 1.4.1 —
                    the real donut always renders a paid/unpaid/overdue
                    legend below the canvas). */}
                <SkeletonBlock className="h-4 w-56" />
              </CardContent>
            </Card>
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
