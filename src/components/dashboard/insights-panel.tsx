/**
 * F9 (T033) — Smart-insights panel (FR-004). Renders the dismissal-filtered
 * insight lines, or a friendly empty state. Pure presentational server
 * component; the caller resolves each line to a localised string.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface InsightLine {
  readonly key: string;
  readonly text: string;
}

export function InsightsPanel({
  title,
  emptyLabel,
  lines,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly lines: readonly InsightLine[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {lines.length === 0 ? (
          <p className="text-body text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="grid gap-2 text-body">
            {lines.map((line) => (
              <li key={line.key}>{line.text}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
