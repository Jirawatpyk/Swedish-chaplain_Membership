/**
 * F9 (T033) — KPI card. Pure presentational server component: a labelled metric
 * tile for the operations dashboard. The caller passes a display-ready,
 * locale-formatted `value` string (currency/number formatting stays in the page).
 */
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function KpiCard({
  label,
  value,
  redactedReason,
}: {
  readonly label: string;
  readonly value: string;
  /**
   * When set, the value is a redaction placeholder (e.g. "—" for a manager's
   * finance KPI, FR-007). A bare "—" is ambiguous to a screen reader, so we add
   * an sr-only explanation + a `title` tooltip so the reason is conveyed to
   * both assistive-tech and pointer users (D6).
   */
  readonly redactedReason?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className="text-3xl tabular-nums"
          {...(redactedReason ? { title: redactedReason } : {})}
        >
          <span aria-hidden={redactedReason ? true : undefined}>{value}</span>
          {redactedReason ? <span className="sr-only">{redactedReason}</span> : null}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
