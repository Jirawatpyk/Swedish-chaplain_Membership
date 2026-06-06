/**
 * T081 — Plan list skeleton (US1, UX standards § 2.1).
 *
 * Renders a shimmer skeleton in the EXACT shape of the final table
 * (same row count, same column widths) so the transition from loading
 * → loaded produces ZERO cumulative layout shift (CLS = 0).
 *
 * Reduced-motion handling (UX standards § 2.2):
 *   - When the user/browser advertises `prefers-reduced-motion: reduce`,
 *     the shimmer gradient is disabled via the `data-reduced-motion`
 *     attribute which the global CSS targets with `animation: none`.
 *   - This component emits `data-reduced-motion="true"` when it detects
 *     the preference; the test `plans-reduced-motion.spec.ts` asserts
 *     this marker is present on reduced-motion runs.
 *
 * Server component — reads `prefers-reduced-motion` is not possible
 * server-side, so the attribute is set client-side on a micro-island.
 */
'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

const DEFAULT_ROW_COUNT = 9; // matches the SweCham 2026 seed row count

function subscribeReducedMotion(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

function getReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getServerReducedMotion(): boolean {
  return false;
}

export interface PlanListSkeletonProps {
  readonly rowCount?: number;
  /**
   * Whether the real table will render the trailing row-actions column
   * (admin view — the `⋯` dropdown). The live table emits 7 columns for
   * admins (name · category · annualFee · memberType · year · status ·
   * actions) and 6 for managers (no actions). Defaults to `false` so the
   * skeleton matches the manager + first-paint baseline: a non-admin
   * always sees CLS 0, and admins see at-most a 1-column shift (the
   * narrow `80px` actions column) on first paint. Mirrors the
   * members-table-skeleton `withSelection` strategy.
   */
  readonly withActions?: boolean;
}

// Column grid templates kept 1:1 with the real <PlansTable> column set
// so the loading → loaded transition holds CLS at 0. The 6-column
// (manager) template is the no-actions baseline; the 7-column (admin)
// template appends a narrow `80px` track for the row-actions `⋯` cell.
const GRID_TEMPLATE_MANAGER = 'grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr]';
const GRID_TEMPLATE_ADMIN = 'grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_80px]';

export function PlanListSkeleton({
  rowCount = DEFAULT_ROW_COUNT,
  withActions = false,
}: PlanListSkeletonProps) {
  const t = useTranslations('admin.plans.create.labels');
  const gridTemplate = withActions ? GRID_TEMPLATE_ADMIN : GRID_TEMPLATE_MANAGER;
  const columnCount = withActions ? 7 : 6;
  // `useSyncExternalStore` is the React-recommended pattern for
  // reading a browser media-query preference into state without the
  // "setState in effect" cascading-render warning (lint rule
  // react-hooks/set-state-in-effect).
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    getServerReducedMotion,
  );

  return (
    <div
      data-plan-list-skeleton
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      // No role="status"/aria-live here — callers wrap this in
      // <PageSkeletonShell> which owns the single live region.
      aria-busy="true"
      className="w-full"
    >
      {/* Header row — column count + grid track widths mirror the real
          <PlansTable> header so the shell never shifts on data land. */}
      <div className="border-b border-border bg-muted/30 px-4 py-3">
        <div className={cn('grid gap-4', gridTemplate)}>
          {Array.from({ length: columnCount }).map((_, c) => (
            <SkeletonCell key={c} className="h-4" />
          ))}
        </div>
      </div>

      {/* Data rows — same grid as the real table */}
      {Array.from({ length: rowCount }).map((_, idx) => (
        <div
          key={idx}
          className="border-b border-border px-4 py-4 last:border-b-0"
        >
          <div className={cn('grid gap-4', gridTemplate)}>
            {Array.from({ length: columnCount }).map((_, c) => (
              <SkeletonCell key={c} className="h-5" />
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">{t('loadingLabel')}</span>
    </div>
  );
}

function SkeletonCell({ className }: { className?: string }) {
  // Animation + reduced-motion handling both live in the shared
  // `.skeleton-shimmer` utility (UX standards § 2.1 / 2.2). The root
  // component still exposes `data-reduced-motion` for the test probe.
  return <div className={cn('rounded-md skeleton-shimmer', className)} />;
}
