'use client';

/**
 * F9 US3 (T058) — virtualized, paginated multi-source timeline stream.
 *
 * Renders the server-loaded first page and a "Load older activity" button
 * that keyset-paginates the next page from `fetchPath` (carrying the current
 * URL filters). The accumulated list is window-virtualized with
 * `@tanstack/react-virtual` so a 1,000+ entry history stays responsive
 * without freezing the page (FR-016) — no nested scroll container, so the
 * page scrolls naturally on mobile.
 *
 * Accessibility: an explicit button (not auto-infinite-scroll) keeps keyboard
 * + screen-reader users in control. Small lists render a semantic `<ol>/<li>`;
 * above the virtualize threshold the windowed container uses `role="list"` +
 * `role="listitem"` (absolute positioning forbids `<ol><li>`), with
 * `aria-setsize`/`aria-posinset` for position context. An sr-only polite live
 * region announces newly-loaded entries (only after a load-more). The source
 * markers are static (reduced-motion friendly).
 *
 * Filter changes are owned by `<TimelineFilters>` (URL state) → the server
 * re-renders the first page → the page remounts this component via a `key`,
 * so local pagination state resets cleanly.
 */

import { useEffect, useRef, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import { History as HistoryIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TimelineEventItem, type TimelineItemProps } from './timeline-event-item';

const VIRTUALIZE_THRESHOLD = 40;

type TimelineApiItem = {
  readonly id: string;
  readonly timestamp: string;
  readonly source: TimelineItemProps['source'];
  readonly event_type: string;
  readonly actor_kind: TimelineItemProps['actorKind'];
  // null for non-audit rows (no single acting user — discriminated union).
  readonly actor_user_id: string | null;
  readonly actor_display_name: string | null;
  readonly payload: Record<string, unknown> | null;
};

export type TimelineStreamProps = {
  /** Base endpoint for load-more (filters are appended from the URL). */
  readonly fetchPath: string;
  readonly initialEvents: readonly TimelineItemProps[];
  readonly initialCursor: string | null;
  /** Localized empty-state copy (filtered vs unfiltered chosen by the page). */
  readonly emptyLabel: string;
  readonly listLabel: string;
};

export function TimelineStream({
  fetchPath,
  initialEvents,
  initialCursor,
  emptyLabel,
  listLabel,
}: TimelineStreamProps) {
  const t = useTranslations('timeline.page');
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<readonly TimelineItemProps[]>(initialEvents);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [isPending, startTransition] = useTransition();
  // Only announce the running count AFTER a load-more — announcing on every
  // mount would re-fire on each filter remount (key=filterKey) and interrupt
  // screen-reader users during rapid filter navigation (review-run I7).
  const [announced, setAnnounced] = useState(false);
  // Index of the first newly-appended row → scrolled into view post-load-more
  // so keyboard/SR users reach the new entries (review-run I8).
  const [scrollTarget, setScrollTarget] = useState<number | null>(null);

  const loadMore = () => {
    if (!cursor) return;
    const appendFromIndex = events.length;
    startTransition(async () => {
      try {
        const url = new URL(fetchPath, window.location.origin);
        // Carry the active filters so the next page stays in the same set.
        for (const key of ['source', 'actorKind', 'from', 'to'] as const) {
          const v = searchParams.get(key);
          if (v) url.searchParams.set(key, v);
        }
        url.searchParams.set('cursor', cursor);
        url.searchParams.set('limit', '50');

        const response = await fetch(url.toString(), {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          toast.error(t('loadError'));
          return;
        }
        const data = (await response.json()) as {
          items: TimelineApiItem[];
          next_cursor: string | null;
        };
        const next: TimelineItemProps[] = data.items.map((i) => ({
          id: i.id,
          timestamp: i.timestamp,
          source: i.source,
          eventType: i.event_type,
          actorKind: i.actor_kind,
          // audit-only; omit for non-audit (optional prop).
          ...(i.actor_user_id ? { actorUserId: i.actor_user_id } : {}),
          actorDisplayName: i.actor_display_name,
          payload: i.payload,
        }));
        setEvents((prev) => [...prev, ...next]);
        setCursor(data.next_cursor);
        setAnnounced(true);
        if (next.length > 0) setScrollTarget(appendFromIndex);
      } catch {
        toast.error(t('loadError'));
      }
    });
  };

  if (events.length === 0) {
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="rounded-full bg-muted p-3">
          {/* 48×48 icon per ux-standards.md § 13 empty-state spec — matches
              the HistoryIcon used for the Timeline nav entry (config/nav.ts)
              and the e-blasts empty-state idiom (icon-in-muted-circle + copy). */}
          <HistoryIcon className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="max-w-md text-sm text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {events.length > VIRTUALIZE_THRESHOLD ? (
        <VirtualizedList
          events={events}
          listLabel={listLabel}
          isBusy={isPending}
          scrollTarget={scrollTarget}
        />
      ) : (
        <ol className="flex flex-col" aria-busy={isPending} aria-label={listLabel}>
          {events.map((e, i) => (
            <li key={e.id} aria-setsize={events.length} aria-posinset={i + 1}>
              <TimelineEventItem {...e} />
            </li>
          ))}
        </ol>
      )}

      {/* Polite live region — announces growth without stealing focus. Empty
          on initial mount + filter remount so it only speaks during a fetch
          or after a load-more (review-run I7). */}
      <span className="sr-only" role="status" aria-live="polite">
        {isPending ? t('loading') : announced ? t('results', { count: events.length }) : ''}
      </span>

      {cursor !== null && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={isPending}
            className="min-h-11"
          >
            {isPending ? t('loading') : t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Window-virtualized list — only the visible window of rows is in the DOM.
 * Uses `role="list"`/`role="listitem"` (not `<ol>/<li>`) because the rows are
 * absolutely positioned, which is invalid inside an `<ol>`.
 */
function VirtualizedList({
  events,
  listLabel,
  isBusy,
  scrollTarget,
}: {
  readonly events: readonly TimelineItemProps[];
  readonly listLabel: string;
  readonly isBusy: boolean;
  /** Index of the first row appended by the last load-more (scroll into view). */
  readonly scrollTarget: number | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // The list's document offset feeds the window virtualizer. Reading
  // `ref.current` during render is disallowed (react-hooks/refs), so it is
  // measured post-mount into state (corrects from 0 on the first paint).
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    if (listRef.current) setScrollMargin(listRef.current.offsetTop);
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: events.length,
    estimateSize: () => 96,
    overscan: 8,
    scrollMargin,
  });

  // After a load-more, bring the first new row into view so keyboard/SR users
  // reach the appended entries (review-run I8).
  useEffect(() => {
    if (scrollTarget !== null && scrollTarget < events.length) {
      virtualizer.scrollToIndex(scrollTarget, { align: 'start' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget]);

  return (
    <div
      ref={listRef}
      role="list"
      aria-label={listLabel}
      aria-busy={isBusy}
      className="relative w-full"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const event = events[vi.index];
        if (!event) return null;
        return (
          <div
            key={event.id}
            role="listitem"
            aria-setsize={events.length}
            aria-posinset={vi.index + 1}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{
              transform: `translateY(${vi.start - scrollMargin}px)`,
            }}
          >
            <TimelineEventItem {...event} />
          </div>
        );
      })}
    </div>
  );
}
