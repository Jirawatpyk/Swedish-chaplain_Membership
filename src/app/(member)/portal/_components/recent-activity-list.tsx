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
 * renders them as a semantic `<ol>` of `<li>` rows. No fetch, no pagination
 * — the preview is limited to 4 items by the server read.
 *
 * Each `TimelineEventItem` is a `<div>`, so it MUST be wrapped in an `<li>`
 * — an `<ol>` whose direct children are non-`<li>` elements fails axe's
 * `list` rule (WCAG 1.3.1). `aria-setsize`/`aria-posinset` give SR users
 * position context (mirrors `timeline-stream.tsx`).
 */
export interface RecentActivityListProps {
  readonly events: readonly TimelineItemProps[];
}

export function RecentActivityList({ events }: RecentActivityListProps): React.ReactElement {
  return (
    <ol className="flex flex-col gap-3">
      {events.map((ev, i) => (
        <li key={ev.id} aria-setsize={events.length} aria-posinset={i + 1}>
          <TimelineEventItem {...ev} />
        </li>
      ))}
    </ol>
  );
}
