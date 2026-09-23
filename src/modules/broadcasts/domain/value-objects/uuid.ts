/**
 * UUID format guard for broadcasts Domain + Application inputs.
 *
 * The broadcasts copy of `members/domain/value-objects/uuid.ts`: that file is
 * not on the members barrel, and a deep import of a sibling module's
 * `domain/` is a Principle III violation, so the check lives here for this
 * module's own untrusted ids (route params) — a malformed id must be refused
 * before it reaches Postgres as a `22P02` 5xx. Pure string inspection.
 */

/** RFC 4122 UUID pattern (any version, case-insensitive). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `raw` is a UUID-formatted string. */
export function isUuid(raw: unknown): raw is string {
  return typeof raw === 'string' && UUID_RE.test(raw);
}
