/**
 * 124 — the Billed vs collected bars, two series per month. Loaded only
 * through `trend-chart.tsx`'s `next/dynamic(..., { ssr: false })`, so recharts
 * stays out of `/admin/finance`'s first-load JS (bundle budget). Decorative:
 * `aria-hidden`; the card's sr-only table is the accessible reading. The
 * current month is drawn lighter (it is still running); months still to come
 * have no bars.
 */
'use client';

import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts';
import {
  CHART_AXIS_TICK,
  CHART_GRID,
  CHART_MARGIN,
  ChartFrame,
  ChartTooltipCard,
  ChartTooltipLine,
  niceTicks,
} from '@/components/dashboard/chart-frame';
import { BILLED_SERIES, COLLECTED_SERIES } from '../_lib/trend-series';

export interface TrendChartPoint {
  readonly key: string;
  /** Short month for the axis ("Jan"). */
  readonly axisLabel: string;
  /** The tooltip's title ("January 2026"). */
  readonly label: string;
  readonly state: 'past' | 'current' | 'future';
  /** Whole baht; null for a month still to come. */
  readonly billed: number | null;
  readonly collected: number | null;
  readonly billedLabel: string;
  readonly collectedLabel: string;
}

function TrendTooltip({
  active,
  payload,
  billedName,
  collectedName,
}: {
  readonly active?: boolean;
  readonly payload?: readonly { readonly payload?: TrendChartPoint }[];
  readonly billedName: string;
  readonly collectedName: string;
}) {
  const point = active ? payload?.[0]?.payload : undefined;
  if (!point || point.state === 'future') return null;
  return (
    <ChartTooltipCard title={point.label}>
      <ChartTooltipLine>
        {billedName}: {point.billedLabel}
      </ChartTooltipLine>
      <ChartTooltipLine>
        {collectedName}: {point.collectedLabel}
      </ChartTooltipLine>
    </ChartTooltipCard>
  );
}

export function TrendChartCanvas({
  points,
  locale,
  billedName,
  collectedName,
}: {
  readonly points: readonly TrendChartPoint[];
  readonly locale: string;
  readonly billedName: string;
  readonly collectedName: string;
}) {
  const max = Math.max(0, ...points.flatMap((p) => [p.billed ?? 0, p.collected ?? 0]));
  const ticks = niceTicks(max);
  const tickFmt = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const data = points.map((p) => ({ ...p }));
  const cellsFor = (fill: string) =>
    data.map((p) => <Cell key={p.key} fill={fill} fillOpacity={p.state === 'current' ? 0.6 : 1} />);
  return (
    <div aria-hidden="true">
      <ChartFrame className="h-56 w-full">
        <BarChart accessibilityLayer={false} data={data} margin={CHART_MARGIN} barGap={2}>
          <CartesianGrid vertical={false} stroke={CHART_GRID} />
          <YAxis
            domain={[0, ticks.at(-1) ?? 0]}
            ticks={ticks}
            tickFormatter={(v: number) => tickFmt.format(v)}
            tick={CHART_AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <XAxis
            dataKey="axisLabel"
            tick={CHART_AXIS_TICK}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={8}
          />
          <Tooltip cursor={false} content={<TrendTooltip billedName={billedName} collectedName={collectedName} />} />
          <Bar dataKey="billed" radius={[2, 2, 0, 0]} maxBarSize={16} isAnimationActive={false}>
            {cellsFor(BILLED_SERIES)}
          </Bar>
          <Bar dataKey="collected" radius={[2, 2, 0, 0]} maxBarSize={16} isAnimationActive={false}>
            {cellsFor(COLLECTED_SERIES)}
          </Bar>
        </BarChart>
      </ChartFrame>
    </div>
  );
}
