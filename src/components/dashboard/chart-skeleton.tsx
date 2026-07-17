/**
 * F9 (067-dashboard-interactive-charts) Task 12 — shared shimmer loading
 * fallback for every chart's `next/dynamic(..., { ssr: false })` canvas
 * boundary (mini-series sparkline / membership-tier bar / invoice-status
 * donut). Recharts must never ship in the `/admin` first-load JS bundle
 * (`check:bundle-budgets` — see `scripts/check-bundle-budgets.ts`'s 067
 * baseline note); the boundary that enforces this lives in each
 * `*-chart.tsx` file, which mounts this component as the dynamic import's
 * `loading` prop. This file itself has ZERO recharts import (and no
 * client-only API), so it never pulls the chart bundle into whatever
 * imports it.
 *
 * CLS contract: the caller MUST size this via `className` to match the
 * resolved canvas's own rendered dimensions EXACTLY (same height utility /
 * inline style the real `ChartContainer` uses at that call site) — this
 * renders in the server HTML in place of the canvas until the client chunk
 * loads and swaps in, so any mismatch is a layout shift the moment it does.
 *
 * `aria-hidden` — a purely decorative placeholder. The accessible
 * `<ChartDataTable>` rendered by the surrounding `*-chart.tsx` is entirely
 * unaffected by this boundary (it lives outside the dynamic-import split).
 *
 * No `'use client'` directive: plain presentational markup with no hooks or
 * browser APIs, so it is equally valid to mount from a Server Component
 * (e.g. a future route-level `loading.tsx`) or, as today, from inside a
 * `'use client'` chart file's `dynamic(..., { loading: () => <ChartSkeleton/> })`.
 */
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function ChartSkeleton({ className }: { readonly className?: string }) {
  return <Skeleton aria-hidden="true" className={cn('w-full', className)} />;
}
