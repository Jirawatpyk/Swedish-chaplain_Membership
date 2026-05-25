/**
 * F9 (T033) — recent-activity feed (FR-003). Live audit events, newest-first.
 * Server-rendered snapshot; the client `ActivityFeedRefresh` control re-fetches
 * and owns the polite live region (a static `aria-live` on this list would
 * never fire). The caller passes display-ready entries (`timeLabel` is
 * locale-formatted in the page).
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ActivityFeedRefresh } from './activity-feed-refresh';

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
  refreshLabel,
  refreshedLabel,
  items,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly refreshLabel: string;
  readonly refreshedLabel: string;
  readonly items: readonly ActivityFeedEntry[];
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>{title}</CardTitle>
        <ActivityFeedRefresh refreshLabel={refreshLabel} refreshedLabel={refreshedLabel} />
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-body text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="grid gap-2 text-body">
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
