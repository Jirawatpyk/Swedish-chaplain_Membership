/**
 * F8 Phase 7 review-fix C-UX-1 + WP8 — Route-level loading skeleton for
 * `/admin/renewals/tier-upgrades`.
 *
 * 122 US7b-1 (T726): the live page renders the section tabs and the queue in
 * one AURA card that is frameless on a phone, so the skeleton draws the same
 * card: a static tab strip (the live `RenewalsSectionTabs` calls
 * `useSearchParams()` and cannot render in a route-level `loading.tsx`), then
 * rows with the 2-line reason cell (WP-P5: one line under-measured the row).
 * `PageSkeletonShell` is the one live region that announces the load.
 *
 * Wrapped in `<TableContainer>` so the `pnpm check:layout` invariant (page +
 * loading both use the same variant) holds.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.renewals.tier_upgrades');
  return (
    <PageSkeletonShell ariaLabel={t('loading')}>
      <TableContainer aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {/* The four section tabs (a Select on a phone). */}
            <div data-slot="tab-strip-skeleton" className="flex items-center gap-[var(--aura-space-4)]" aria-hidden>
              <SkeletonBlock className="h-9 w-full sm:hidden" />
              <SkeletonBlock className="hidden h-6 w-20 sm:block" />
              <SkeletonBlock className="hidden h-6 w-32 sm:block" />
              <SkeletonBlock className="hidden h-6 w-16 sm:block" />
              <SkeletonBlock className="hidden h-6 w-32 sm:block" />
            </div>
            {/* Rows: member · current plan · suggested plan · reason (2
                lines) · status · Accept and ⋯. */}
            <div className="flex flex-col" aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-[var(--aura-space-2)] border-t border-[var(--aura-border-subtle)] py-[var(--aura-space-3)] sm:grid sm:grid-cols-12 sm:items-start sm:gap-[var(--aura-space-4)]"
                >
                  <SkeletonBlock className="h-5 w-40 sm:col-span-2 sm:w-full" />
                  <SkeletonBlock className="h-9 w-full sm:col-span-2" />
                  <SkeletonBlock className="hidden h-9 w-full sm:col-span-2 sm:block" />
                  <div className="flex flex-col gap-1 sm:col-span-3" data-slot="reason-skeleton">
                    <SkeletonBlock className="h-5 w-full" />
                    <SkeletonBlock className="h-3 w-3/4" />
                  </div>
                  <SkeletonBlock className="hidden h-6 w-full sm:col-span-1 sm:block" />
                  <div className="flex gap-[var(--aura-space-2)] sm:col-span-2 sm:justify-end">
                    <SkeletonBlock className="h-11 flex-1 sm:h-8 sm:w-16 sm:flex-none" />
                    <SkeletonBlock className="size-11 sm:size-8" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
