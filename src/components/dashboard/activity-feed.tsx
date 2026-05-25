/**
 * F9 (T033) — recent-activity feed (FR-003). Live audit events, newest-first.
 * `aria-live="polite"` so updates are announced without stealing focus. Pure
 * presentational server component; the caller passes display-ready entries
 * (the `timeLabel` is locale-formatted in the page).
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface ActivityFeedEntry {
  readonly id: string;
  readonly summary: string;
  /** ISO 8601 for the `<time dateTime>` attribute. */
  readonly occurredAt: string;
  /** Locale-formatted display label. */
  readonly timeLabel: string;
}

export function ActivityFeed({
  title,
  emptyLabel,
  items,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly items: readonly ActivityFeedEntry[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-body text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul aria-live="polite" className="grid gap-2 text-body">
            {items.map((item) => (
              <li key={item.id} className="flex items-baseline justify-between gap-3">
                <span>{item.summary}</span>
                <time
                  dateTime={item.occurredAt}
                  className="shrink-0 text-caption text-muted-foreground tabular-nums"
                >
                  {item.timeLabel}
                </time>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
