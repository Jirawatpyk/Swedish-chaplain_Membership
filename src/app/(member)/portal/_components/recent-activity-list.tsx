'use client';

import {
  TimelineEventItem,
  type TimelineItemProps,
} from '@/components/members/timeline-event-item';

/**
 * 057 portal redesign §4.1 — thin client wrapper for the recent-activity
 * preview list.
 *
 * `TimelineEventItem` uses `useTranslations` (client hook) so it can only
 * render inside a client boundary. This wrapper accepts the already-shaped
 * `TimelineItemProps[]` resolved by the server `RecentActivitySection` and
 * renders them as a plain `<ol>`. No fetch, no pagination — the preview
 * is limited to 4 items by the server read.
 */
export interface RecentActivityListProps {
  readonly events: readonly TimelineItemProps[];
}

export function RecentActivityList({ events }: RecentActivityListProps): React.ReactElement {
  return (
    <ol className="flex flex-col gap-3">
      {events.map((ev) => (
        <TimelineEventItem key={ev.id} {...ev} />
      ))}
    </ol>
  );
}
