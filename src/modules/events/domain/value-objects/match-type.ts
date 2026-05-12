/**
 * T015 — `MatchType` value object (F6).
 *
 * Discriminator for the 4-rule attendee-to-member match cascade per FR-012:
 *   1. `member_contact` — exact contact-email match (highest confidence)
 *   2. `member_domain`  — email-domain match on members.email_domain (skipped
 *                          for personal-email-deny-list domains per research.md R4)
 *   3. `member_fuzzy`   — Levenshtein-distance match on normalised company name
 *   4. `non_member`     — none of the above; attendee has a valid email but
 *                          no member affinity
 *   5. `unmatched`      — ambiguous fuzzy match (>1 winner with equal distance)
 *
 * The DB CHECK constraint on `event_registrations.match_type` enforces the
 * same closed set; this Domain VO provides compile-time enforcement.
 *
 * Pure TypeScript — Constitution Principle III.
 */

export const MATCH_TYPES = [
  'member_contact',
  'member_domain',
  'member_fuzzy',
  'non_member',
  'unmatched',
] as const;

export type MatchType = (typeof MATCH_TYPES)[number];

/**
 * Type guard — narrows an unknown string to `MatchType`. Useful for parsing
 * Drizzle row values back into the Domain (where Drizzle returns `text` as
 * a plain `string` with no compile-time guarantee on shape).
 */
export function isMatchType(value: unknown): value is MatchType {
  return (
    typeof value === 'string' &&
    (MATCH_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Subset that REQUIRES `matched_member_id IS NULL` AND quota flags=false
 * per Domain invariant FR-013 (defence-in-depth alongside DB CHECK).
 */
export const NON_QUOTA_MATCH_TYPES = ['non_member', 'unmatched'] as const;
export type NonQuotaMatchType = (typeof NON_QUOTA_MATCH_TYPES)[number];

export function isNonQuotaMatchType(
  value: MatchType,
): value is NonQuotaMatchType {
  return (NON_QUOTA_MATCH_TYPES as readonly string[]).includes(value);
}
