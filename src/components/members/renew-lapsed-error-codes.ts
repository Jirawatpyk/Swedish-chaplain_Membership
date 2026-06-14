/**
 * 068-f8-completion (cluster D) — the error codes the
 * `POST /api/admin/members/[id]/renew` route can emit in its
 * `{ error: { code } }` body, each of which `RenewLapsedMemberDialog` maps to
 * a dedicated `admin.members.detail.renewLapsed.toast.error.*` toast copy.
 *
 * Extracted as a pure `.ts` leaf (no React / no server import graph) so the
 * i18n-coverage unit test can pin EVERY emittable code against the real
 * en.json — closing the MISSING_MESSAGE-at-runtime class: unit tests mock
 * next-intl (so `t()` never throws on a missing key) and `check:i18n` is
 * parity-only (not code-ref), so a forgotten key for a new route error code
 * would otherwise pass every gate and render the raw dotted key path at
 * runtime. The dialog itself additionally guards with `t.has(...)` so an
 * UNKNOWN future code falls back to `server_error` cleanly — this list is the
 * set that must resolve to its OWN copy.
 *
 * Keep this in sync with the route's error switch
 * (`src/app/api/admin/members/[id]/renew/route.ts`). A new emittable code
 * there must be added here + given copy in en/th/sv.
 */
export const RENEW_LAPSED_ERROR_CODES = [
  'feature_disabled',
  'rate_limited',
  'invalid_body',
  'invalid_input',
  'member_not_found',
  'member_archived',
  'member_has_active_cycle',
  'plan_not_found',
  'invoice_issue_failed',
  'server_error',
] as const;

/**
 * The closed union of codes the renew route may emit. The route's
 * `errorResponse({ code })` calls are typed against this union (see
 * `renew/route.ts`), so emitting a code NOT in this list is a COMPILE error
 * — keeping the route's switch and this i18n-pinned set provably in sync.
 */
export type RenewLapsedErrorCode = (typeof RENEW_LAPSED_ERROR_CODES)[number];

/**
 * Compile-time count pin (mirrors `_AssertCycleStatusCount` in
 * `cycle-status.ts`) — accidentally adding/dropping a code from the tuple
 * without updating this expected count is a build error, a second guard
 * alongside the route's typed switch + the i18n-coverage unit test.
 */
type _AssertRenewLapsedErrorCodeCount =
  (typeof RENEW_LAPSED_ERROR_CODES)['length'] extends 10
    ? true
    : 'RENEW_LAPSED_ERROR_CODES count mismatch — expected 10';
const _assertRenewLapsedErrorCodeCount: _AssertRenewLapsedErrorCodeCount = true;
void _assertRenewLapsedErrorCodeCount;
