/**
 * F9 (FR-001a) — 12-month cumulative member-growth trend (line). Not
 * finance-bearing, so shown to admin + manager. Display-ready props only;
 * the SVG renderer is internal.
 */
import { MiniSeriesChart, type MiniSeriesPoint } from './_mini-series-chart';

export function MemberGrowthChart({
  title,
  emptyLabel,
  monthHeader,
  countHeader,
  points,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly monthHeader: string;
  readonly countHeader: string;
  readonly points: readonly MiniSeriesPoint[];
}) {
  return (
    <MiniSeriesChart
      title={title}
      emptyLabel={emptyLabel}
      labelHeader={monthHeader}
      valueHeader={countHeader}
      variant="line"
      points={points}
    />
  );
}
