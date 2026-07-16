/**
 * F9 (FR-001a) → 067-dashboard-interactive-charts Task 12 — the Recharts
 * canvas extracted OUT of `_mini-series-chart.tsx` so the recharts module
 * graph sits entirely behind a `next/dynamic(..., { ssr: false })` boundary
 * (bundle-budget constraint — recharts must never ship in `/admin`'s
 * first-load JS). `_mini-series-chart.tsx` still owns the summary stat,
 * delta chip, range labels, sparse hint, empty state, and the accessible
 * `<ChartDataTable>` — all of which render eagerly/server-side; only the
 * decorative canvas below is lazy.
 *
 * This is a straight lift of the pre-Task-12 `SeriesCanvas` (+ its private
 * tooltip/label/dot helpers) — same props, same rendering, no behaviour
 * change. See `_mini-series-chart.tsx`'s docblock for the variant/a11y/
 * reduced-motion rationale (unchanged by this split).
 *
 * Only `import type` reaches back into `_mini-series-chart.tsx` (for
 * `MiniSeriesPoint`) — fully erased at compile time, so this file has zero
 * runtime dependency on its caller (the caller's dynamic `import()` is the
 * only real edge between the two chunks).
 */
'use client';

import { Area, AreaChart, Bar, BarChart, ReferenceLine, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import type { MiniSeriesPoint } from './_mini-series-chart';

interface SeriesTooltipPayloadEntry {
  readonly payload?: MiniSeriesPoint;
}

/** Custom tooltip content — reads the ORIGINAL `MiniSeriesPoint` off the
 * hovered payload entry directly (its pre-formatted `label`/`valueLabel`),
 * rather than fighting shadcn's config/nameKey-driven `ChartTooltipContent`,
 * which is built for multi-series/legend charts, not this single-series
 * sparkline. Never the sole way to read a value — see the a11y note in
 * `_mini-series-chart.tsx`'s docblock. */
function SeriesTooltipContent({
  active,
  payload,
}: {
  readonly active?: boolean;
  readonly payload?: readonly SeriesTooltipPayloadEntry[];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="grid gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium text-foreground">{point.label}</span>
      <span className="text-muted-foreground">{point.valueLabel}</span>
    </div>
  );
}

/** Renders the max-gridline's label as a plain SVG `<text>` (not Recharts'
 * canvas-measuring `Text` component) — left-aligned at the reference line's
 * position so it never collides with the peak point (these trends peak at
 * the most-recent, right-most point), matching the original hand-rolled
 * `MaxGridline` annotation 1:1. */
function renderMaxReferenceLabel(maxLabel: string) {
  return function MaxReferenceLabel({ viewBox }: { viewBox?: { x: number; y: number } }) {
    if (!viewBox) return null;
    return (
      <text x={viewBox.x} y={viewBox.y + 11} className="fill-muted-foreground" fontSize={10}>
        {maxLabel}
      </text>
    );
  };
}

/** Custom per-point dot for the `line`/`Area` variant — mirrors the original
 * `LineSvg` comment ("a dot per month … with the latest point emphasised"):
 * every point gets a small dot (`r=1.5`) except the last, which is bigger
 * (`r=3`). A plain `dot={{ r: 1.5 }}` object config applies uniformly to
 * every point, so this needs a render function closing over the series
 * length to single out the final index. */
function makeSeriesDot(lastIndex: number) {
  return function SeriesDot({
    cx,
    cy,
    index,
  }: {
    readonly cx?: number;
    readonly cy?: number;
    readonly index?: number;
  }) {
    if (cx === undefined || cy === undefined) return null;
    return (
      <circle
        key={index}
        cx={cx}
        cy={cy}
        r={index === lastIndex ? 3 : 1.5}
        fill="var(--color-value)"
        strokeWidth={0}
      />
    );
  };
}

const CHART_MARGIN = { top: 12, right: 8, bottom: 4, left: 8 };

export interface MiniSeriesCanvasProps {
  readonly points: readonly MiniSeriesPoint[];
  readonly max: number;
  readonly maxLabel: string | null;
  readonly variant: 'bar' | 'line';
  readonly allowMotion: boolean;
}

export function MiniSeriesCanvas({ points, max, maxLabel, variant, allowMotion }: MiniSeriesCanvasProps) {
  const chartConfig = {
    value: { color: 'var(--primary)' },
  } satisfies ChartConfig;
  const maxReferenceLineProps = maxLabel ? { label: renderMaxReferenceLabel(maxLabel) } : {};

  return (
    <div aria-hidden="true" data-chart-variant={variant}>
      <ChartContainer config={chartConfig} className="aspect-auto h-28 w-full">
        {variant === 'bar' ? (
          // Revenue trend — the original `BarSvg` drew a `<rect>` per month;
          // preserve that as a Recharts `<Bar>` (NOT a Line — a bar series
          // rendered as a line would be a visual regression).
          <BarChart accessibilityLayer={false} data={points} margin={CHART_MARGIN}>
            <YAxis hide domain={[0, max]} />
            <XAxis dataKey="key" hide />
            <ReferenceLine y={0} stroke="var(--border)" />
            <ReferenceLine y={max} stroke="var(--border)" strokeDasharray="3 3" {...maxReferenceLineProps} />
            <ChartTooltip cursor={false} content={<SeriesTooltipContent />} />
            <Bar
              dataKey="value"
              fill="var(--color-value)"
              radius={[2, 2, 0, 0]}
              maxBarSize={28}
              minPointSize={3}
              isAnimationActive={allowMotion}
            />
          </BarChart>
        ) : (
          // Member growth — the original `LineSvg` drew a filled area
          // (`fill-primary/15`) UNDER a stroked polyline, not a bare line;
          // an `<Area>` (fill + stroke) is required, or the blue fill under
          // the curve is a visual regression.
          <AreaChart accessibilityLayer={false} data={points} margin={CHART_MARGIN}>
            <YAxis hide domain={[0, max]} />
            <XAxis dataKey="key" hide />
            <ReferenceLine y={0} stroke="var(--border)" />
            <ReferenceLine y={max} stroke="var(--border)" strokeDasharray="3 3" {...maxReferenceLineProps} />
            <ChartTooltip cursor={false} content={<SeriesTooltipContent />} />
            <Area
              dataKey="value"
              type="monotone"
              stroke="var(--color-value)"
              strokeWidth={2}
              fill="var(--color-value)"
              fillOpacity={0.15}
              dot={makeSeriesDot(points.length - 1)}
              activeDot={{ r: 4 }}
              isAnimationActive={allowMotion}
            />
          </AreaChart>
        )}
      </ChartContainer>
    </div>
  );
}
