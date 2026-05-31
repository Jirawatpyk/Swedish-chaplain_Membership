/**
 * F9 (FR-001a) — 12-month paid-revenue trend (bar). Finance-bearing, but
 * visible to ALL staff (admins + the read-only-on-finance manager role) per
 * FR-007; the empty state renders only when a tenant has no paid revenue yet.
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
