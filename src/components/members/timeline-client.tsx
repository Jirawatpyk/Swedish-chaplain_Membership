'use client';

/**
 * T132 — Timeline client wrapper (US6).
 *
 * Renders the initial server-loaded events and provides a "Load more"
 * button that fetches the next page from `/api/members/[id]/timeline`.
 *
 * Design choices:
 *   - "Load more" button (not auto-infinite-scroll) keeps keyboard + screen
 *     reader users in control and avoids CLS jumps.
 *   - `aria-live="polite"` on the list announces newly-loaded events.
 *   - `prefers-reduced-motion` is honoured by the static dot marker
 *     (no CSS animation on the timeline rail) — no runtime check needed.
 */

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { TimelineEventItem, type TimelineItemProps } from './timeline-event-item';

export type TimelineClientProps = {
  readonly memberId: string;
  readonly initialEvents: readonly TimelineItemProps[];
  readonly initialCursor: string | null;
};

export function TimelineClient({
  memberId,
  initialEvents,
  initialCursor,
}: TimelineClientProps) {
  const t = useTranslations('admin.members.timeline');
  const [events, setEvents] = useState<readonly TimelineItemProps[]>(initialEvents);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [isPending, startTransition] = useTransition();

  const loadMore = () => {
    if (!cursor) return;
    startTransition(async () => {
      try {
        const url = new URL(
          `/api/members/${memberId}/timeline`,
          window.location.origin,
        );
        url.searchParams.set('cursor', cursor);
        url.searchParams.set('limit', '50');

        const response = await fetch(url.toString(), {
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          toast.error(t('loading'));
          return;
        }

        const data = (await response.json()) as {
          items: Array<{
            id: string;
            timestamp: string;
            event_type: string;
            actor_user_id: string;
            actor_display_name: string | null;
            payload: Record<string, unknown> | null;
          }>;
          next_cursor: string | null;
        };

        const newEvents: TimelineItemProps[] = data.items.map((i) => ({
          id: i.id,
          timestamp: i.timestamp,
          eventType: i.event_type,
          actorUserId: i.actor_user_id,
          actorDisplayName: i.actor_display_name,
          payload: i.payload,
        }));

        setEvents((prev) => [...prev, ...newEvents]);
        setCursor(data.next_cursor);
      } catch {
        toast.error(t('loading'));
      }
    });
  };

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        {t('empty')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ol
        className="flex flex-col"
        aria-live="polite"
        aria-busy={isPending}
        aria-label={t('title')}
      >
        {events.map((event) => (
          <TimelineEventItem key={event.id} {...event} />
        ))}
      </ol>

      {cursor !== null && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={isPending}
            aria-label={t('loadMore')}
          >
            {isPending ? t('loading') : t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
