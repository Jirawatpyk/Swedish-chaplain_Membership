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
          actions. WP-P5 CLS fix: `grid-cols-12` with per-column spans mirrors
          the live `<table>`'s content-driven widths (reason widest, status
          narrowest) instead of equal `grid-cols-6`, and the reason cell renders
          TWO skeleton lines to match the live 2-line (reason + evidence) cell —
          a single line under-measured the row and shifted the layout on load. */}
      <div className="rounded-md border">
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-12 gap-4 border-b py-2" aria-hidden>
            <Skeleton className="col-span-2 h-4 w-full" />
            <Skeleton className="col-span-2 h-4 w-full" />
            <Skeleton className="col-span-2 h-4 w-full" />
            <Skeleton className="col-span-3 h-4 w-full" />
            <Skeleton className="col-span-1 h-4 w-full" />
            <Skeleton className="col-span-2 h-4 w-full" />
          </div>
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-12 items-start gap-4 py-2"
              aria-hidden
            >
              <Skeleton className="col-span-2 h-5 w-full" />
              <Skeleton className="col-span-2 h-5 w-full" />
              <Skeleton className="col-span-2 h-5 w-full" />
              {/* Reason cell = reason label + evidence sub-line (2 lines). */}
              <div
                className="col-span-3 flex flex-col gap-1"
                data-slot="reason-skeleton"
              >
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
              <Skeleton className="col-span-1 h-5 w-full" />
              {/* Last col mimics the 3 action buttons */}
              <div className="col-span-2 flex justify-end gap-2">
                <Skeleton className="h-8 w-14" />
                <Skeleton className="h-8 w-14" />
                <Skeleton className="h-8 w-14" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </TableContainer>
  );
}
