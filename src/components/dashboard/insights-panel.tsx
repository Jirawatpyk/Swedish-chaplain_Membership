/**
 * F9 (T033) — Smart-insights panel (FR-004). Renders the dismissal-filtered
 * insight lines (each with a dismiss control), or a friendly empty state. The
 * caller resolves each line to a localised string + the dismiss labels.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InsightDismissButton } from './insight-dismiss-button';

export interface InsightLine {
  readonly key: string;
  readonly text: string;
  /** Member/segment ref the insight referenced; threaded into the dismissal key. */
  readonly scopeRef?: string;
}

export function InsightsPanel({
  title,
  emptyLabel,
  dismissLabel,
  dismissedLabel,
  dismissErrorLabel,
  lines,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly dismissLabel: string;
  readonly dismissedLabel: string;
  readonly dismissErrorLabel: string;
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
              <li key={line.key} className="flex items-center justify-between gap-2">
                <span>{line.text}</span>
                <InsightDismissButton
                  insightKey={line.key}
                  {...(line.scopeRef !== undefined ? { scopeRef: line.scopeRef } : {})}
                  label={dismissLabel}
                  successLabel={dismissedLabel}
                  errorLabel={dismissErrorLabel}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
