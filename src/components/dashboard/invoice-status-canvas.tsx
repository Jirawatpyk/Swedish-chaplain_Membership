/**
 * F9 (067-dashboard-interactive-charts) Task 12 — the Recharts donut canvas
 * extracted OUT of `invoice-status-chart.tsx` so the recharts module graph
 * sits entirely behind a `next/dynamic(..., { ssr: false })` boundary
 * (bundle-budget constraint — recharts must never ship in `/admin`'s
 * first-load JS). `invoice-status-chart.tsx` still owns the `distribution`
 * → `BucketRow[]` computation, the empty state, the centre-total overlay,
 * the visible legend, the draft caption, and the accessible
 * `<ChartDataTable>` — all of which render eagerly/server-side; only the
 * decorative `<PieChart>` below is lazy.
 *
 * Straight lift of the pre-Task-12 inline `<PieChart>` block (+ its private
 * tooltip helper) — same rendering, no behaviour change.
 *
 * `BUCKET_FILL` (the bucket → semantic-colour map) is a genuine RUNTIME
 * value needed by BOTH this lazy canvas (`<Cell fill=…>`) AND the eager
 * chart file's visible legend swatches — it is therefore declared in
 * `invoice-status-chart.tsx` (the eager file) and imported here as a real
 * value. This direction is safe: by the time this module is ever evaluated
 * (triggered by the caller's dynamic `import()`), `invoice-status-chart.tsx`
 * has already fully loaded (it's the one doing the importing) — and,
 * critically, it means `invoice-status-chart.tsx` never has a STATIC value
 * import from this file, so recharts can never be pulled back into the
 * eager chunk. `BucketRow` is a type-only import (fully erased either way).
 */
'use client';

import { Cell, Pie, PieChart } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { BUCKET_FILL, type BucketRow } from './invoice-status-chart';

interface BucketTooltipPayloadEntry {
  readonly payload?: BucketRow;
}

/** Custom tooltip — reads the ORIGINAL `BucketRow` off the hovered payload
 * entry directly (its resolved `label`/`amountLabel`/`countLabel`/
 * `pctLabel`), mirroring `membership-tier-canvas.tsx`'s `TierTooltipContent`:
 * shadcn's config/nameKey-driven `ChartTooltipContent` is built for multi-
 * series/legend charts, not this single-series donut. Never the sole way to
 * read a value — the hidden `<ChartDataTable>` (in the caller) is. */
function BucketTooltipContent({
  active,
  payload,
}: {
  readonly active?: boolean;
  readonly payload?: readonly BucketTooltipPayloadEntry[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="grid gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium text-foreground">{row.label}</span>
      <span className="text-muted-foreground">{row.amountLabel}</span>
      <span className="text-muted-foreground">
        {row.countLabel} · {row.pctLabel}
      </span>
    </div>
  );
}

export interface InvoiceStatusCanvasProps {
  readonly rows: readonly BucketRow[];
  readonly allowMotion: boolean;
}

export function InvoiceStatusCanvas({ rows, allowMotion }: InvoiceStatusCanvasProps) {
  const chartConfig = Object.fromEntries(
    rows.map((r) => [r.bucket, { label: r.label }]),
  ) as ChartConfig;

  return (
    <ChartContainer config={chartConfig} className="mx-auto aspect-square max-h-64 w-full">
      <PieChart accessibilityLayer={false}>
        <ChartTooltip cursor={false} content={<BucketTooltipContent />} />
        <Pie
          data={rows}
          dataKey="satangNumber"
          nameKey="label"
          innerRadius="60%"
          outerRadius="100%"
          paddingAngle={2}
          isAnimationActive={allowMotion}
        >
          {rows.map((r) => (
            <Cell key={r.bucket} fill={BUCKET_FILL[r.bucket]} stroke="var(--card)" strokeWidth={3} />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}
