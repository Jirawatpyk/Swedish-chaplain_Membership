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
}

export function PlanListSkeleton({ rowCount = DEFAULT_ROW_COUNT }: PlanListSkeletonProps) {
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
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading plans"
      className="w-full"
    >
      {/* Header row */}
      <div className="border-b border-border bg-muted/30 px-4 py-3">
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_80px] gap-4">
          <SkeletonCell className="h-4" reducedMotion={reducedMotion} />
          <SkeletonCell className="h-4 w-24" reducedMotion={reducedMotion} />
          <SkeletonCell className="h-4 w-28" reducedMotion={reducedMotion} />
          <SkeletonCell className="h-4 w-24" reducedMotion={reducedMotion} />
          <SkeletonCell className="h-4 w-16" reducedMotion={reducedMotion} />
          <SkeletonCell className="h-4 w-12" reducedMotion={reducedMotion} />
        </div>
      </div>

      {/* Data rows — same grid as the real table */}
      {Array.from({ length: rowCount }).map((_, idx) => (
        <div
          key={idx}
          className="border-b border-border px-4 py-4 last:border-b-0"
        >
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_80px] gap-4">
            <SkeletonCell className="h-5 w-48" reducedMotion={reducedMotion} />
            <SkeletonCell className="h-5 w-24" reducedMotion={reducedMotion} />
            <SkeletonCell className="h-5 w-28" reducedMotion={reducedMotion} />
            <SkeletonCell className="h-5 w-20" reducedMotion={reducedMotion} />
            <SkeletonCell className="h-5 w-16" reducedMotion={reducedMotion} />
            <SkeletonCell className="h-5 w-8" reducedMotion={reducedMotion} />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading plan list…</span>
    </div>
  );
}

function SkeletonCell({
  className,
  reducedMotion,
}: {
  className?: string;
  reducedMotion: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-md bg-muted',
        reducedMotion ? 'opacity-60' : 'animate-pulse',
        className,
      )}
    />
  );
}
