/**
 * F9 US3 — client-safe timeline source/actor enums.
 *
 * These value arrays are needed at runtime by BOTH the application use case
 * (zod schema) and the client `<TimelineFilters>` component. They live here —
 * a pure leaf with zero imports — so the client never has to import them from
 * the `@/modules/members` barrel, which would drag the server-only module
 * graph (drizzle repos, `next/cache`) into the client bundle.
 */

/** The six timeline sources unioned by `member_timeline_v`. */
export const TIMELINE_SOURCES = [
  'audit',
  'invoice',
  'payment',
  'event',
  'broadcast',
  'renewal',
] as const;

/** Actor classification for the FR-015 actor filter + display. */
export const TIMELINE_ACTOR_KINDS = ['staff', 'member', 'system'] as const;

export type TimelineSource = (typeof TIMELINE_SOURCES)[number];
export type TimelineActorKind = (typeof TIMELINE_ACTOR_KINDS)[number];

/** Narrow a raw query-string value to a known source (else undefined). */
export function asTimelineSource(v: string | undefined): TimelineSource | undefined {
  return v && (TIMELINE_SOURCES as readonly string[]).includes(v)
    ? (v as TimelineSource)
    : undefined;
}

/** Narrow a raw query-string value to a known actor kind (else undefined). */
export function asTimelineActorKind(
  v: string | undefined,
): TimelineActorKind | undefined {
  return v && (TIMELINE_ACTOR_KINDS as readonly string[]).includes(v)
    ? (v as TimelineActorKind)
    : undefined;
}
