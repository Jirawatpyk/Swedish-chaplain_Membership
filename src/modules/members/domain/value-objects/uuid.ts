/**
 * Shared UUID format helper for F3 Domain value objects.
 *
 * Intra-Domain utility — used by `member.ts` (`tryMemberId`) and
 * `contact.ts` (`tryContactId`) to keep the regex in one place. Pure
 * string inspection, zero framework imports, satisfies Principle III.
 */

/** RFC 4122 UUID pattern (any version, case-insensitive). */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runtime type guard — returns true iff the value is a valid UUID string. */
export function isUuid(raw: unknown): raw is string {
  return typeof raw === 'string' && UUID_RE.test(raw);
}
