import { getTranslations } from 'next-intl/server';
import { Stat } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { env } from '@/lib/env';
import { CardSkeleton } from './_components/card-states';

/**
 * 124 US5.1 — `/admin/finance` while the page reads: the header, the filters
 * as a disabled row (not the live FilterBar, which reads the URL — a loading
 * file must not suspend on it), the four tiles loading, and each card's
 * skeleton at its loaded height (the same `CardSkeleton` the page's Suspense
 * islands show, so nothing moves when they resolve). An sr-only status says
 * what is loading. The tiles' captions are the generic ones; the figures'
 * own captions arrive with them.
 */
export default async function Loading() {
  const t = await getTranslations('admin.invoiceDashboard');
  return (
    <PageSkeletonShell ariaLabel={t('states.loading')}>
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('states.loadingAsOf')} />
        {/* The row the FilterBar draws: four selects (Origin only with
            auto-invoice), or below 640px the one full-width Filters button. */}
        <div aria-hidden="true" className="flex flex-wrap gap-2 opacity-55">
          {[
            t('filters.type'),
            t('filters.fiscalYear'),
            t('filters.plan'),
            ...(env.features.autoInvoice ? [t('filters.origin')] : []),
          ].map((label) => (
            <span
              key={label}
              className="inline-flex h-9 items-center rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] px-3 text-sm text-[var(--aura-fg-secondary)] max-sm:hidden"
            >
              {label}
            </span>
          ))}
          <span className="h-11 w-full rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] sm:hidden" />
        </div>
        <div aria-hidden="true" className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[t('tiles.outstanding'), t('tiles.overdue'), t('tiles.collectedMonth'), t('trend.legendCollected')].map((label) => (
            <Stat key={label} label={label} caption={<SkeletonBlock className="h-[1.375rem] w-24" />} loading />
          ))}
        </div>
        <div aria-hidden="true" className="grid gap-4 lg:grid-cols-10">
          <div className="order-2 lg:order-none lg:col-span-5">
            <CardSkeleton loadingLabel={t('states.loadingCard')} kind="aging" title={t('aging.title')} description={t('aging.description')} />
          </div>
          <div className="order-1 lg:order-none lg:col-span-5">
            <CardSkeleton loadingLabel={t('states.loadingCard')} kind="attention" title={t('attention.title')} />
          </div>
          <div className="order-3 lg:order-none lg:col-span-10">
            <CardSkeleton loadingLabel={t('states.loadingCard')} kind="oldestOverdue" title={t('oldest.title')} description={t('oldest.description')} />
          </div>
          <div className="order-4 lg:order-none lg:col-span-6">
            <CardSkeleton loadingLabel={t('states.loadingCard')} kind="trend" title={t('trend.title')} />
          </div>
          <div className="order-5 lg:order-none lg:col-span-4">
            <CardSkeleton loadingLabel={t('states.loadingCard')} kind="methods" title={t('methods.title')} />
          </div>
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
