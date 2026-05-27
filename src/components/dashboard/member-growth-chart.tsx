/**
 * F9 (FR-001a) — 12-month cumulative member-growth trend (line). Not
 * finance-bearing, so shown to admin + manager. Display-ready props only;
 * the SVG renderer is internal.
 */
import {
  MiniSeriesChart,
  type MiniSeriesDelta,
  type MiniSeriesPoint,
  type MiniSeriesSummary,
} from './_mini-series-chart';

export function MemberGrowthChart({
  title,
  caption,
  emptyLabel,
  sparseLabel,
  monthHeader,
  countHeader,
  summary,
  delta,
  points,
}: {
  readonly title: string;
  readonly caption?: string;
  readonly emptyLabel: string;
  readonly sparseLabel?: string;
  readonly monthHeader: string;
  readonly countHeader: string;
  readonly summary: MiniSeriesSummary;
  readonly delta?: MiniSeriesDelta;
  readonly points: readonly MiniSeriesPoint[];
}) {
  return (
    <MiniSeriesChart
      title={title}
      {...(caption !== undefined ? { caption } : {})}
      emptyLabel={emptyLabel}
      {...(sparseLabel !== undefined ? { sparseLabel } : {})}
      labelHeader={monthHeader}
      valueHeader={countHeader}
      variant="line"
      summary={summary}
      {...(delta !== undefined ? { delta } : {})}
      points={points}
    />
  );
}
