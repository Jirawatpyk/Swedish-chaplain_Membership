/**
 * F9 (FR-001a) — 12-month paid-revenue trend (bar). Finance-bearing: the page
 * passes `points: []` for managers (redacted) → renders the empty state.
 * Display-ready props only (no data fetch); the SVG renderer is internal.
 */
import {
  MiniSeriesChart,
  type MiniSeriesPoint,
  type MiniSeriesSummary,
} from './_mini-series-chart';

export function RevenueTrendChart({
  title,
  caption,
  emptyLabel,
  sparseLabel,
  monthHeader,
  amountHeader,
  summary,
  points,
}: {
  readonly title: string;
  readonly caption?: string;
  readonly emptyLabel: string;
  readonly sparseLabel?: string;
  readonly monthHeader: string;
  readonly amountHeader: string;
  readonly summary: MiniSeriesSummary;
  readonly points: readonly MiniSeriesPoint[];
}) {
  return (
    <MiniSeriesChart
      title={title}
      {...(caption !== undefined ? { caption } : {})}
      emptyLabel={emptyLabel}
      {...(sparseLabel !== undefined ? { sparseLabel } : {})}
      labelHeader={monthHeader}
      valueHeader={amountHeader}
      variant="bar"
      summary={summary}
      points={points}
    />
  );
}
