/**
 * Audit-viewer filter validation.
 *
 * `target_user_id` is a UUID column, so a non-UUID `targetRef` (a member
 * number, a name, a typo, or a tampered URL) would reach Postgres as an invalid
 * uuid cast (22P02) and throw — 500-ing the whole audit page. Validate it up
 * front and render the graceful invalid-filter state instead (parity with the
 * from/to date-range guard).
 *
 * `actorUserId` is a TEXT column (it also holds `system:*` sentinels) and
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
