/**
 * F9 (067-dashboard-interactive-charts) Task 12 — the Recharts canvas
 * extracted OUT of `membership-tier-chart.tsx` so the recharts module graph
 * sits entirely behind a `next/dynamic(..., { ssr: false })` boundary
 * (bundle-budget constraint — recharts must never ship in `/admin`'s
 * first-load JS). `membership-tier-chart.tsx` still owns the `slices` →
 * `TierRow[]` computation, the empty state, and the accessible
 * `<ChartDataTable>` — all of which render eagerly/server-side; only the
 * decorative horizontal bar below is lazy.
 *
 * Straight lift of the pre-Task-12 inline `<BarChart>` block (+ its private
 * tooltip helper) — same rendering, no behaviour change. `TierRow` moves
 * here (canvas owns its own data shape); `membership-tier-chart.tsx`
 * type-imports it back (erased at compile time — no runtime dependency in
 * that direction, only this file's dynamic `import()` is a real edge).
 */
'use client';

import { Bar, BarChart, LabelList, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';

/** Row shape fed to Recharts — `displayLabel` is the (possibly translated)
 * text shown on the Y axis + tooltip; `barLabel` is the pre-formatted
 * "count (pct%)" end-of-bar label (a plain data field, not a Recharts
 * `formatter`, so `<LabelList>` needs no canvas-measuring render function). */
export interface TierRow {
  readonly tierKey: string;
  readonly displayLabel: string;
  readonly count: number;
  readonly pctLabel: string;
  readonly barLabel: string;
}

interface TierTooltipPayloadEntry {
  readonly payload?: TierRow;
}

/** Custom tooltip — reads the ORIGINAL `TierRow` off the hovered payload
 * entry directly (its resolved `displayLabel` + pre-formatted `barLabel`),
 * mirroring `_mini-series-chart.tsx`'s `SeriesTooltipContent`: shadcn's
 * config/nameKey-driven `ChartTooltipContent` is built for multi-series/
 * legend charts, not this single-series bar. Never the sole way to read a
 * value — the hidden `<ChartDataTable>` (in the caller) is. */
function TierTooltipContent({
  active,
  payload,
}: {
  readonly active?: boolean;
  readonly payload?: readonly TierTooltipPayloadEntry[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="grid gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium text-foreground">{row.displayLabel}</span>
      <span className="text-muted-foreground">{row.barLabel}</span>
    </div>
  );
}

const CHART_MARGIN = { top: 4, right: 44, bottom: 4, left: 4 };

export interface MembershipTierCanvasProps {
  readonly rows: readonly TierRow[];
  readonly max: number;
  readonly allowMotion: boolean;
  /** Translated "Members" column header — the ChartConfig `count` series
   * label. Not rendered anywhere visible today (no shadcn default tooltip/
   * legend is used — see `TierTooltipContent` above), kept only to satisfy
   * `ChartContainer`'s required `config` prop faithfully. */
  readonly countColumnHeader: string;
}

export function MembershipTierCanvas({ rows, max, allowMotion, countColumnHeader }: MembershipTierCanvasProps) {
  const chartConfig = {
    count: { label: countColumnHeader },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-full w-full">
      <BarChart layout="vertical" accessibilityLayer={false} data={rows} margin={CHART_MARGIN}>
        <YAxis
          type="category"
          dataKey="displayLabel"
          width={110}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 12 }}
        />
        <XAxis type="number" hide domain={[0, max]} />
        <ChartTooltip cursor={false} content={<TierTooltipContent />} />
        {/* Single colour, single <Bar> — never one <Cell>/colour per
            slice (the design doc rejects per-tier hue: only 5 chart
            tokens across 2 lightness clusters can't distinguish up
            to 9 tiers, a CVD fail). */}
        <Bar
          dataKey="count"
          fill="var(--chart-1)"
          radius={[0, 4, 4, 0]}
          minPointSize={2}
          isAnimationActive={allowMotion}
        >
          <LabelList dataKey="barLabel" position="right" className="fill-foreground" fontSize={12} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
