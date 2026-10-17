/**
 * Spec 122 US11 — the staff dashboard's own chart frame, in place of the
 * legacy `ui/chart` (`ChartContainer` / `ChartTooltip`, deleted at US13).
 *
 * It is a plain recharts `ResponsiveContainer` in a `data-slot="chart"` box
 * (the e2e reads that slot). The size is seeded with `initialDimension`, so
 * the first paint (and jsdom) has a canvas before any resize is observed.
 * Colours come from AURA's chart tokens; the brand theme sets
 * `--aura-chart-1` in both themes.
 *
 * Imported only by the three canvases, which sit behind
 * `next/dynamic(..., { ssr: false })`, so recharts stays out of `/admin`'s
 * first-load JS.
 */
'use client';

import type { ReactElement, ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';

import { cn } from '@/lib/utils';

/** The one series colour: bars, areas and lines. */
export const CHART_SERIES = 'var(--aura-chart-1)';
/** Grid and reference lines. */
export const CHART_GRID = 'var(--aura-chart-grid)';

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;

export function ChartFrame({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactElement;
}) {
  return (
    <div
      data-slot="chart"
      className={cn(
        'flex justify-center text-xs [&_.recharts-cartesian-axis-tick-value]:fill-[var(--aura-chart-axis)] [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden',
        className,
      )}
    >
      <ResponsiveContainer initialDimension={INITIAL_DIMENSION}>{children}</ResponsiveContainer>
    </div>
  );
}

/** The hover tooltip's box: a title line and its value lines. Never the only
 * way to read a value — each chart has a screen-reader table. */
export function ChartTooltipCard({ title, children }: { readonly title: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="grid gap-0.5 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] px-2.5 py-1.5 text-xs shadow-[var(--aura-shadow-overlay)]">
      <span className="font-medium text-[var(--aura-fg-primary)]">{title}</span>
      {children}
    </div>
  );
}

/** A secondary line inside `ChartTooltipCard`. */
export function ChartTooltipLine({ children }: { readonly children: ReactNode }) {
  return <span className="text-[var(--aura-fg-secondary)]">{children}</span>;
}
