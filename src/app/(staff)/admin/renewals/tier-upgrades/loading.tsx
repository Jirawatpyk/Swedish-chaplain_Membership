/**
 * F8 Phase 7 review-fix C-UX-1 + WP8 — Route-level loading skeleton for
 * `/admin/renewals/tier-upgrades`.
 *
 * WP8 (BP5 item 2) — CLS fix: the live page renders the queue inside a plain
 * `<div className="rounded-md border">` wrapper and a `<RenewalsSectionTabs>`
 * strip, NOT a `<Card>`. The prior skeleton used a `<Card>` (rounded-lg +
 * padding + shadow) and omitted the tab strip, so the loaded table shifted the
 * layout. This mirrors the real shape.
 *
 * `RenewalsSectionTabs` calls `useSearchParams()` and so cannot render inside a
 * route-level `loading.tsx` without its own Suspense boundary — a STATIC
 * tab-strip skeleton reproduces its visual mass instead.
 *
 * Wrapped in `<TableContainer>` so `pnpm check:layout` invariant (page +
 * loading both use the same variant) holds.
 */
import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.renewals.tier_upgrades');
  return (
    <TableContainer aria-busy="true">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {/* sr-only AT announcement (WCAG 4.1.3 Status Messages). */}
      <p className="sr-only" role="status" aria-live="polite">
        {t('loading')}
      </p>
      {/* Static tab-strip skeleton mirroring <RenewalsSectionTabs> (4 tabs) —
          the live component can't render here (useSearchParams), so reproduce
          its footprint to hold CLS=0. */}
      <div
        data-slot="tab-strip-skeleton"
        className="flex items-center gap-1.5"
        aria-hidden
      >
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      {/* Table shell mirrors the live queue's `rounded-md border` wrapper (NOT
          a Card). 6 cols: member · from-plan · to-plan · reason · status ·
          actions. */}
      <div className="rounded-md border">
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-6 gap-4 border-b py-2" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-6 gap-4 py-2"
              aria-hidden
            >
              {Array.from({ length: 5 }).map((_, colIdx) => (
                <Skeleton key={colIdx} className="h-5 w-full" />
              ))}
              {/* Last col mimics the 3 action buttons */}
              <div className="flex justify-end gap-2">
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-8 w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </TableContainer>
  );
}
