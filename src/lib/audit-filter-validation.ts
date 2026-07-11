/**
 * Audit-viewer filter validation (shared by the staff page + the CSV export API
 * route — a generic input guard, hence `src/lib/` rather than a route-private
 * `_lib/`).
 *
 * `audit_log.target_user_id` is a UUID column and `audit_log.event_type` is a
 * Postgres enum column, so a non-UUID `targetRef` or an unknown `eventType`
 * (member number, name, typo, or tampered URL) would reach Postgres as an
 * invalid cast (22P02) and throw — 500-ing the page / returning a bare 500 on
 * the export route. Validate both up front and degrade to the graceful
 * invalid-filter state / 400 (parity with the from/to date-range guard).
 *
 * `actor_user_id` is a TEXT column (it also holds `system:*` sentinels) and
 * tolerates any string, so it is intentionally NOT constrained here.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `targetRef` is safe to send to the uuid `target_user_id` filter:
 * empty (no filter applied) or a well-formed UUID.
 */
export function isValidTargetRef(targetRef: string): boolean {
  return targetRef === '' || UUID_RE.test(targetRef);
}

/**
 * True when `eventType` is safe to send to the enum `event_type` filter: empty
 * (no filter) or a member of the known audit-event-type set. `allowed` is the
 * canonical set (pass `ALL_AUDIT_EVENT_TYPES`) — kept as a parameter so this
 * guard stays a pure `@/lib` helper with no module dependency. Exact-match, so
 * hyphenated enum values (e.g. `plan-cross-tenant-probe`) are handled.
 */
export function isValidEventTypeFilter(
  eventType: string,
  allowed: readonly string[],
): boolean {
  return eventType === '' || allowed.includes(eventType);
}
