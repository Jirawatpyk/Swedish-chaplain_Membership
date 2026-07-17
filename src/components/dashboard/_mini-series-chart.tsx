/**
 * F9 (FR-001a) — dashboard trend-card sparkline. Migrated
 * (067-dashboard-interactive-charts, Task 9 — Decision #2) from a hand-rolled
 * SVG to Recharts — `variant="bar"` (revenue trend) renders a Recharts
 * `<BarChart><Bar/></BarChart>`; `variant="line"` (member growth) renders a
 * Recharts `<AreaChart><Area/></AreaChart>` (NOT a bare `<Line>` — the
 * original `LineSvg` drew a filled `fill-primary/15` area under the curve
 * PLUS the stroked polyline on top, so the Recharts replacement must be an
 * `<Area>` with both `fill`+`fillOpacity` and `stroke` set, or the blue fill
 * is a visual regression). This preserves each caller's original chart
 * shape 1:1 (the old `BarSvg` drew `<rect>` bars) — only the drawing engine
 * changed. Client component — Recharts renders via the DOM/ResizeObserver,
 * so this can't stay a server component; callers still pass display-ready
 * props (no data fetching here).
 *
 * Readability: a prominent `summary` stat (sized to match `KpiCard`) + a
 * per-chart `caption` (per-month vs cumulative) + first→last month range
 * labels give at-a-glance meaning even when the sparkline is sparse; a
 * dashed max-value reference line + baseline keep the 12-month frame
 * legible. Hovering/focusing a point shows a tooltip (month + value) — a
 * bonus, never the only way to read the data (see Accessibility below).
 *
 * Accessibility (WCAG 1.1.1 / 1.3.1 / 1.4.1 — canvas is decorative, never
 * colour-only): the Recharts canvas sits inside an `aria-hidden="true"`
 * wrapper and sets `accessibilityLayer={false}` — the single a11y model
 * shared by every 067 chart (see `chart-data-table.tsx`'s docblock). The
 * accessible equivalent is the shared `<ChartDataTable>` (rendered when
 * data is present; the empty-state paragraph is the SR equivalent
 * otherwise) — the tooltip is never the sole way to read a value. The
 * optional delta chip pairs a ▲/▼ glyph + text with colour so it is not
 * colour-only.
 *
 * Reduced motion: `isAnimationActive` defaults to `false` on the server
 * snapshot and the client's hydration-matching first render (SSR-safe — no
 * hydration mismatch), then flips to `true` once the browser confirms
 * `prefers-reduced-motion: no-preference` post-mount — same
 * `useSyncExternalStore` idiom as `components/plans/plan-list-skeleton.tsx`.
 * The subscribe/snapshot triad lives in the shared `./use-motion-preference`
 * (Task 10 — extracted so `membership-tier-chart.tsx` doesn't duplicate it).
 *
 * **Lazy canvas boundary (Task 12 — bundle-budget constraint):** the actual
 * Recharts rendering (`<BarChart>`/`<AreaChart>` + their tooltip/label/dot
 * helpers) lives in `./mini-series-canvas` and is mounted here via
 * `next/dynamic(..., { ssr: false })`, so recharts never lands in `/admin`'s
 * first-load JS. Everything in THIS file (summary stat, delta chip, range
 * labels, sparse hint, empty state, `<ChartDataTable>`) renders eagerly —
 * only the decorative canvas is deferred, and its `loading` fallback
 * (`<ChartSkeleton className="h-28" />`) matches the canvas's own `h-28`
 * height exactly, so swapping the skeleton for the real chart causes no
 * layout shift.
 */
'use client';

import dynamic from 'next/dynamic';
import { useSyncExternalStore } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ChartDataTable } from './chart-data-table';
import { ChartSkeleton } from './chart-skeleton';
import {
  getAllowMotion,
  getServerAllowMotion,
  subscribeMotionPreference,
} from './use-motion-preference';

const MiniSeriesCanvas = dynamic(
  () => import('./mini-series-canvas').then((m) => m.MiniSeriesCanvas),
  { ssr: false, loading: () => <ChartSkeleton className="h-28" /> },
);

export interface MiniSeriesPoint {
  /** Stable key (e.g. 'YYYY-MM'). */
  readonly key: string;
  /** Localised axis/row label (e.g. 'Jun 2026'). */
  readonly label: string;
  /** Numeric magnitude for the chart geometry. */
  readonly value: number;
  /** Display-ready value for the table cell + tooltip (e.g. '฿1,200'). */
  readonly valueLabel: string;
}

/**
 * The prominent at-a-glance stat shown above the sparkline. Caller-supplied:
 * `value` MUST be an aggregate of the same `points[]` passed to the chart (e.g.
 * the 12-month total / latest cumulative), pre-formatted for the locale — the
 * chart does not recompute it, so keep the two in sync at the call site.
 */
export interface MiniSeriesSummary {
  readonly value: string;
  readonly label: string;
}

/** Optional trend-direction chip next to the summary (glyph + text, not colour-only). */
export interface MiniSeriesDelta {
  readonly direction: 'up' | 'down';
  readonly label: string;
}

/** Below this many months carrying a non-zero value the series is "sparse". */
const SPARSE_THRESHOLD = 3;

export function MiniSeriesChart({
  title,
  caption,
  emptyLabel,
  sparseLabel,
  labelHeader,
  valueHeader,
  variant,
  summary,
  delta,
  points,
}: {
  readonly title: string;
  /** Per-chart semantic caption (e.g. 'Per month' / 'Cumulative') — disambiguates the series. */
  readonly caption?: string;
  readonly emptyLabel: string;
  /** Optional localised "limited history" hint shown when data is sparse. */
  readonly sparseLabel?: string;
  readonly labelHeader: string;
  readonly valueHeader: string;
  readonly variant: 'bar' | 'line';
  readonly summary: MiniSeriesSummary;
  readonly delta?: MiniSeriesDelta;
  readonly points: readonly MiniSeriesPoint[];
}) {
  const allowMotion = useSyncExternalStore(
    subscribeMotionPreference,
    getAllowMotion,
    getServerAllowMotion,
  );
  const hasData = points.length > 0 && points.some((p) => p.value > 0);
  const dataMonths = points.reduce((n, p) => (p.value > 0 ? n + 1 : n), 0);
  const isSparse = hasData && dataMonths < SPARSE_THRESHOLD;
  const max = points.reduce((m, p) => Math.max(m, p.value), 0);
  const maxPoint = points.find((p) => p.value === max && max > 0);
  const maxLabel = maxPoint ? maxPoint.valueLabel : null;
  const first = points[0];
  const last = points.at(-1);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
        {caption ? <CardDescription>{caption}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="text-body text-muted-foreground">{emptyLabel}</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-baseline gap-2">
                <span className="text-3xl tabular-nums">{summary.value}</span>
                {delta ? (
                  <span
                    className={cn(
                      'text-caption font-medium tabular-nums',
                      // AA-safe delta colours at 14px (QA TC-019). Up =
                      // emerald-700 (~5.5:1 on white) / emerald-400 on dark.
                      // The down delta only renders when data trends down, so
                      // the data-dependent axe scan never exercised it — pin
                      // explicit red-700 (~5.9:1 on white) / red-400 on dark
                      // rather than the `text-destructive` token, whose
                      // contrast isn't guaranteed ≥4.5:1 for text.
                      delta.direction === 'up'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400',
                    )}
                  >
                    {delta.direction === 'up' ? '▲' : '▼'} {delta.label}
                  </span>
                ) : null}
              </span>
              <span className="text-right text-caption text-muted-foreground">{summary.label}</span>
            </div>
            <div className="mt-3">
              <MiniSeriesCanvas
                points={points}
                max={max}
                maxLabel={maxLabel}
                variant={variant}
                allowMotion={allowMotion}
              />
            </div>
            {first && last ? (
              <div className="mt-1 flex justify-between text-caption text-muted-foreground tabular-nums">
                <span>{first.label}</span>
                <span>{last.label}</span>
              </div>
            ) : null}
            {isSparse && sparseLabel ? (
              <p className="mt-2 text-caption text-muted-foreground">{sparseLabel}</p>
            ) : null}
            {/* Accessible equivalent (WCAG 1.1.1 / 1.3.1 / 1.4.1) — the sole
                SR/no-JS data path; visually hidden when data is present, the
                empty-state paragraph above is the SR equivalent otherwise. */}
            <ChartDataTable
              caption={title}
              columns={[labelHeader, valueHeader]}
              rows={points.map((p) => [p.label, p.valueLabel])}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
