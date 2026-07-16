/**
 * F9 (T033) — KPI card. Pure presentational server component: a labelled metric
 * tile for the operations dashboard. The caller passes a display-ready,
 * locale-formatted `value` (currency/number formatting stays in the page).
 *
 * `value` widened from `string` to `ReactNode` (Task 15,
 * 067-dashboard-interactive-charts) so a caller can pass
 * `<CountUp value={n} locale={locale} variant="integer" />` for the
 * rolling-number animation without this component needing to know anything
 * about it — plain string callers keep working unchanged.
 */
import type { ReactNode } from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function KpiCard({
  label,
  value,
}: {
  readonly label: string;
  readonly value: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
