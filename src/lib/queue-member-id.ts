/**
 * #82 / #89 — the E-Blast queue's `?memberId=` counts only when it is a UUID;
 * anything else is ignored. Lowercased, as Postgres prints a uuid, so the
 * server's queue filter and the client's selected option agree on one value.
 * Client-safe (no server imports): the filter bar reads the same rule.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function queueMemberIdParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw.toLowerCase() : undefined;
}
