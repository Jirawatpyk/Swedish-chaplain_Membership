/**
 * F9 (FR-001a) — internal self-built SVG mini chart for the dashboard trend
 * cards. NO charting dependency (Constitution X). Pure presentational server
 * component with a STABLE display-ready prop contract — the SVG renderer is a
 * swappable internal (research R8); callers never depend on its markup.
 *
 * Readability: a prominent `summary` stat (sized to match `KpiCard`) + a
 * per-chart `caption` (per-month vs cumulative) + first→last month range labels
 * give at-a-glance meaning even when the sparkline is sparse; a baseline axis +
 * per-month marks (slot ticks in the bar variant, dots in the line variant)
 * keep the 12-month frame legible. Each datum carries a native `<title>` for
 * pointer hover.
 *
 * Accessibility (WCAG 1.4.1 — no colour-only): the `<svg>` is decorative
 * (`aria-hidden`); data is conveyed by the visible summary + the visually-hidden
 * `<table>` (accessible equivalent, rendered when data is present; the
 * empty-state paragraph is the SR equivalent otherwise) + bar height / line
 * position — never colour. The optional delta chip pairs a ▲/▼ glyph + text
 * with colour so it is not colour-only.
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface MiniSeriesPoint {
  /** Stable key (e.g. 'YYYY-MM'). */
  readonly key: string;
  /** Localised axis/row label (e.g. 'Jun 2026'). */
  readonly label: string;
  /** Numeric magnitude for the SVG geometry. */
  readonly value: number;
  /** Display-ready value for the table cell + hover title (e.g. '฿1,200'). */
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

const VIEW_W = 320;
const VIEW_H = 110;
const PAD = 6;
const BASE_Y = VIEW_H - PAD; // baseline (x-axis)
const TOP_Y = PAD;
const PLOT_H = BASE_Y - TOP_Y;
const MIN_BAR = 3; // floor so a small non-zero value is a crisp mark, not a blob

function MaxGridline({ maxLabel }: { readonly maxLabel: string | null }) {
  // Faint dashed top gridline = the Y-scale ceiling. The max-value label sits
  // top-LEFT (not right): these trends peak at the most-recent (right-most)
  // point, so a right-aligned label collided with the peak bar/dot — the left
  // is empty for a growth series.
  return (
    <>
      <line
        x1={PAD}
        y1={TOP_Y}
        x2={VIEW_W - PAD}
        y2={TOP_Y}
        className="stroke-border"
        strokeWidth={1}
        strokeDasharray="3 3"
      />
      {maxLabel ? (
        <text x={PAD} y={TOP_Y + 11} className="fill-muted-foreground" fontSize={10}>
          {maxLabel}
        </text>
      ) : null}
    </>
  );
}

function BarSvg({
  points,
  max,
  maxLabel,
}: {
  readonly points: readonly MiniSeriesPoint[];
  readonly max: number;
  readonly maxLabel: string | null;
}) {
  const innerW = VIEW_W - PAD * 2;
  const slot = innerW / points.length;
  const barW = Math.max(2, slot * 0.6);
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-28 w-full" aria-hidden="true">
      <MaxGridline maxLabel={maxLabel} />
      <line x1={PAD} y1={BASE_Y} x2={VIEW_W - PAD} y2={BASE_Y} className="stroke-border" strokeWidth={1} />
      {points.map((p, i) => {
        const cx = PAD + i * slot + slot / 2;
        const h = max > 0 && p.value > 0 ? Math.max((p.value / max) * PLOT_H, MIN_BAR) : 0;
        return (
          <g key={p.key}>
            {/* faint per-month slot tick so all 12 months read as a frame */}
            <line x1={cx} y1={BASE_Y} x2={cx} y2={BASE_Y + 2} className="stroke-border" strokeWidth={1} />
            {h > 0 ? (
              <rect
                x={cx - barW / 2}
                y={BASE_Y - h}
                width={barW}
                height={h}
                rx={h < 4 ? 0 : 1}
                className="fill-primary"
              >
                <title>{`${p.label}: ${p.valueLabel}`}</title>
              </rect>
            ) : (
              // Zero / no-data month → faint baseline dot, distinct from the tick.
              <circle cx={cx} cy={BASE_Y} r={1} className="fill-muted-foreground/40">
                <title>{`${p.label}: ${p.valueLabel}`}</title>
              </circle>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function LineSvg({
  points,
  max,
  maxLabel,
}: {
  readonly points: readonly MiniSeriesPoint[];
  readonly max: number;
  readonly maxLabel: string | null;
}) {
  const innerW = VIEW_W - PAD * 2;
  const yOf = (v: number): number => BASE_Y - (max > 0 ? (v / max) * PLOT_H : 0);
  if (points.length === 1) {
    const only = points[0]!;
    return (
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-28 w-full" aria-hidden="true">
        <MaxGridline maxLabel={maxLabel} />
        <line x1={PAD} y1={BASE_Y} x2={VIEW_W - PAD} y2={BASE_Y} className="stroke-border" strokeWidth={1} />
        <circle cx={VIEW_W / 2} cy={yOf(only.value)} r={3} className="fill-primary">
          <title>{`${only.label}: ${only.valueLabel}`}</title>
        </circle>
      </svg>
    );
  }
  const step = innerW / (points.length - 1);
  const coords = points.map((p, i) => ({ x: PAD + i * step, y: yOf(p.value), p }));
  const linePath = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  // Subtle area fill under the line → a flat-then-spike series reads as growth.
  const areaPath =
    `M ${coords[0]!.x.toFixed(1)},${BASE_Y} ` +
    coords.map((c) => `L ${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') +
    ` L ${coords.at(-1)!.x.toFixed(1)},${BASE_Y} Z`;
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-28 w-full" aria-hidden="true">
      <MaxGridline maxLabel={maxLabel} />
      <line x1={PAD} y1={BASE_Y} x2={VIEW_W - PAD} y2={BASE_Y} className="stroke-border" strokeWidth={1} />
      <path d={areaPath} className="fill-primary/15" />
      <polyline points={linePath} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {/* A dot per month so flat (baseline-hugging) months read as "present, low"
          — not an empty axis — with the latest point emphasised. */}
      {coords.map((c, i) => (
        <circle key={c.p.key} cx={c.x} cy={c.y} r={i === coords.length - 1 ? 3 : 1.5} className="fill-primary">
          <title>{`${c.p.label}: ${c.p.valueLabel}`}</title>
        </circle>
      ))}
    </svg>
  );
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
                      // emerald-700 (not -600) so the 14px delta meets WCAG AA
                      // 4.5:1 on white (~5.5:1); -600 was 3.65:1 (QA TC-019).
                      delta.direction === 'up' ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive',
                    )}
                  >
                    {delta.direction === 'up' ? '▲' : '▼'} {delta.label}
                  </span>
                ) : null}
              </span>
              <span className="text-right text-caption text-muted-foreground">{summary.label}</span>
            </div>
            <div className="mt-3">
              {variant === 'bar' ? (
                <BarSvg points={points} max={max} maxLabel={maxLabel} />
              ) : (
                <LineSvg points={points} max={max} maxLabel={maxLabel} />
              )}
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
            {/* Accessible equivalent (WCAG 1.4.1) — visually hidden when data is
                present; the empty-state paragraph is the SR equivalent otherwise. */}
            <table className="sr-only">
              <caption>{title}</caption>
              <thead>
                <tr>
                  <th scope="col">{labelHeader}</th>
                  <th scope="col">{valueHeader}</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.key}>
                    <th scope="row">{p.label}</th>
                    <td>{p.valueLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
