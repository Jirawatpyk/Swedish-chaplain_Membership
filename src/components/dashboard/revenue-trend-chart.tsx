/**
 * F9 (FR-001a) — 12-month paid-revenue trend (bar). Finance-bearing: the page
 * passes `points: []` for managers (redacted) → renders the empty state.
 * Display-ready props only (no data fetch); the SVG renderer is internal.
 */
import { MiniSeriesChart, type MiniSeriesPoint } from './_mini-series-chart';

export function RevenueTrendChart({
  title,
  emptyLabel,
  monthHeader,
  amountHeader,
  points,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly monthHeader: string;
  readonly amountHeader: string;
  readonly points: readonly MiniSeriesPoint[];
}) {
  return (
    <MiniSeriesChart
      title={title}
      emptyLabel={emptyLabel}
      labelHeader={monthHeader}
      valueHeader={amountHeader}
      variant="bar"
      points={points}
    />
  );
}
