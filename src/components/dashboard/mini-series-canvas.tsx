/**
 * F9 (FR-001a) → 067-dashboard-interactive-charts Task 12 — the Recharts
 * canvas extracted OUT of `_mini-series-chart.tsx` so the recharts module
 * graph sits entirely behind a `next/dynamic(..., { ssr: false })` boundary
 * (bundle-budget constraint — recharts must never ship in `/admin`'s
 * first-load JS). `_mini-series-chart.tsx` still owns the summary stat,
 * delta chip, sparse hint, empty state, and the accessible
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

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts';
import {
  CHART_AXIS_TICK as AXIS_TICK,
  CHART_GRID,
  CHART_MARGIN,
  CHART_SERIES,
  ChartFrame,
  ChartTooltipCard,
  ChartTooltipLine,
  niceTicks,
} from './chart-frame';
import type { MiniSeriesPoint } from './_mini-series-chart';

interface SeriesTooltipPayloadEntry {
  readonly payload?: MiniSeriesPoint;
}

/** Custom tooltip content — reads the ORIGINAL `MiniSeriesPoint` off the
 * hovered payload entry directly (its pre-formatted `label`/`valueLabel`),
 * in the dashboard's token tooltip card (spec 122 US11). Never the sole way to read a value — see the a11y note in
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
    <ChartTooltipCard title={point.label}>
      <ChartTooltipLine>{point.valueLabel}</ChartTooltipLine>
    </ChartTooltipCard>
  );
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
        fill={CHART_SERIES}
        strokeWidth={0}
      />
    );
  };
}

export interface MiniSeriesCanvasProps {
  readonly points: readonly MiniSeriesPoint[];
  readonly max: number;
  readonly variant: 'bar' | 'line';
  readonly allowMotion: boolean;
  /** Formats the value-axis ticks (compact: "150K"). */
  readonly locale: string;
  /** Points are in a minor unit (satang = 100): ticks show the major unit. */
  readonly valueDivisor?: number;
}

export function MiniSeriesCanvas({
  points,
  max,
  variant,
  allowMotion,
  locale,
  valueDivisor = 1,
}: MiniSeriesCanvasProps) {
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? 0;
  const tickFmt = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const formatTick = (v: number) => tickFmt.format(v / valueDivisor);
  // The month axis reads the short label when the caller gives one.
  const data = points.map((p) => ({ ...p, axisLabel: p.axisLabel ?? p.label }));
  const lastIndex = points.length - 1;
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke={CHART_GRID} />
      <YAxis
        domain={[0, top]}
        ticks={ticks}
        tickFormatter={formatTick}
        tick={AXIS_TICK}
        tickLine={false}
        axisLine={false}
        width={40}
      />
      <XAxis
        dataKey="axisLabel"
        tick={AXIS_TICK}
        tickLine={false}
        axisLine={false}
        interval="preserveStartEnd"
        minTickGap={8}
      />
      <Tooltip cursor={false} content={<SeriesTooltipContent />} />
    </>
  );

  return (
    <div aria-hidden="true" data-chart-variant={variant}>
      <ChartFrame className="h-48 w-full">
        {variant === 'bar' ? (
          // Revenue trend — the original `BarSvg` drew a `<rect>` per month;
          // preserve that as a Recharts `<Bar>` (NOT a Line — a bar series
          // rendered as a line would be a visual regression).
          <BarChart accessibilityLayer={false} data={data} margin={CHART_MARGIN}>
            {axes}
            <Bar
              dataKey="value"
              fill={CHART_SERIES}
              radius={[2, 2, 0, 0]}
              maxBarSize={28}
              minPointSize={3}
              isAnimationActive={allowMotion}
            >
              {/* The last month is still in progress (the card's caption
                  says so), so it is drawn lighter, as the board does: 0.6
                  keeps the blended fill at 3:1 on the card in both themes
                  (WCAG 1.4.11; 0.45 measured 2.25:1), and a solid dashed
                  outline marks the bar as partial. */}
              {data.map((p, i) =>
                i === lastIndex ? (
                  <Cell key={p.key} fillOpacity={0.6} stroke={CHART_SERIES} strokeDasharray="3 2" />
                ) : (
                  <Cell key={p.key} />
                ),
              )}
            </Bar>
          </BarChart>
        ) : (
          // Member growth — the original `LineSvg` drew a filled area
          // (15% of the series colour) UNDER a stroked polyline, not a bare line;
          // an `<Area>` (fill + stroke) is required, or the blue fill under
          // the curve is a visual regression.
          <AreaChart accessibilityLayer={false} data={data} margin={CHART_MARGIN}>
            {axes}
            <Area
              dataKey="value"
              type="monotone"
              stroke={CHART_SERIES}
              strokeWidth={2}
              fill={CHART_SERIES}
              fillOpacity={0.15}
              dot={makeSeriesDot(lastIndex)}
              activeDot={{ r: 4 }}
              isAnimationActive={allowMotion}
            />
          </AreaChart>
        )}
      </ChartFrame>
    </div>
  );
}
