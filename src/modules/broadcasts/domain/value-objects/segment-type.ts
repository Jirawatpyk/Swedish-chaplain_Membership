/**
 * T024 — `BroadcastSegmentType` Domain value object (F7).
 *
 * 4-value recipient targeting taxonomy (FR-015). Mirror of
 * `broadcastSegmentTypeEnum` in Infrastructure schema. Discriminator
 * field of the `RecipientSegment` discriminated union (T027).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

export const BROADCAST_SEGMENT_TYPES = [
  'all_members',
  'tier',
  'event_attendees_last_90d',
  'custom',
] as const;

export type BroadcastSegmentType = (typeof BROADCAST_SEGMENT_TYPES)[number];

export function isBroadcastSegmentType(
  value: unknown,
): value is BroadcastSegmentType {
  return (
    typeof value === 'string' &&
    (BROADCAST_SEGMENT_TYPES as readonly string[]).includes(value)
  );
}
