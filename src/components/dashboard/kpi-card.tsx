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
  caption,
}: {
  readonly label: string;
  readonly value: ReactNode;
  /**
   * Optional one-line basis note under the value (e.g. the revenue tile's
   * "Fiscal year to date · ex-VAT"). Every money/count figure on the dashboard
   * is computed on a different basis; stating each tile's basis here keeps the
   * label short while a viewer can still tell why two tiles don't tie out.
   */
  readonly caption?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
        {caption ? <p className="mt-1 text-caption text-muted-foreground">{caption}</p> : null}
      </CardHeader>
    </Card>
  );
}
