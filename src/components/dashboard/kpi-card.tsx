/**
 * F9 (T033) — KPI card. Pure presentational server component: a labelled metric
 * tile for the operations dashboard. The caller passes a display-ready,
 * locale-formatted `value` string (currency/number formatting stays in the page).
 */
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function KpiCard({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
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
