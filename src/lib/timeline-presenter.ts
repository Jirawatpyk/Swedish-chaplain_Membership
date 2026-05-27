/**
 * F9 US3 — shared timeline-event presenters (review-run simplify).
 *
 * The two load-more API routes and the two SSR pages all serialise the same
 * `TimelineEvent` union into either a snake_case JSON item or the client
 * `TimelineItemProps`. Centralising both mappings here removes ~4 copies of
 * identical logic AND keeps the discriminated-union `actorUserId` handling
 * (audit-only) in ONE place (review-run I5).
 *
 * Server-only module: imports the server `TimelineEvent` type. The client
 * `<TimelineStream>` reverse-maps untyped JSON itself.
 */
import type { TimelineEvent } from '@/modules/members';
import type { TimelineItemProps } from '@/components/members/timeline-event-item';

/** snake_case JSON item for the `/api/.../timeline` load-more responses. */
export function toTimelineApiItem(e: TimelineEvent) {
  return {
    id: e.id,
    timestamp: e.timestamp.toISOString(),
    source: e.source,
    event_type: e.eventType,
    actor_kind: e.actorKind,
    // actorUserId exists only on audit rows (discriminated union); the other
    // sources have no single acting user.
    actor_user_id: e.source === 'audit' ? e.actorUserId : null,
    actor_display_name: e.actorDisplayName,
    payload: e.payload,
  };
}

/** Client component props for the SSR first page. */
export function toTimelineItemProps(e: TimelineEvent): TimelineItemProps {
  return {
    id: e.id,
    timestamp: e.timestamp.toISOString(),
    source: e.source,
    eventType: e.eventType,
    actorKind: e.actorKind,
    // actorUserId is audit-only — omit it for the other sources (optional
    // prop; `exactOptionalPropertyTypes` forbids assigning undefined).
    ...(e.source === 'audit' ? { actorUserId: e.actorUserId } : {}),
    actorDisplayName: e.actorDisplayName,
    payload: e.payload,
  };
}
