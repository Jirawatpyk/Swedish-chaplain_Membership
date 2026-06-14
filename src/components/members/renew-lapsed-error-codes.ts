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
export const RENEW_LAPSED_ERROR_CODES: readonly string[] = [
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
];
