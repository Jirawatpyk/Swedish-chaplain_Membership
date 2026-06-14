/**
 * 070 F8 item #18 — canonical list of error codes the reject-reactivation
 * route emits in `{ error: { code } }`, surfaced as toasts by
 * `PendingReactivationActions` via `t(\`reject.error.${code}\`)`.
 *
 * Single-sourced so the i18n-coverage unit test
 * (`pending-reactivation-error-i18n.test.ts`) can assert every code has a
 * non-empty `admin.renewals.cycleDetail.pendingReactivation.reject.error.*`
 * EN key. The component guards with `t.has(...)` + a `server_error`
 * fallback, so an UNKNOWN future code degrades gracefully — but each code
 * here is one the route ACTUALLY returns, so each must resolve to its own
 * copy. Keep in sync with the `switch` in
 * `src/app/api/admin/renewals/[cycleId]/reject/route.ts`.
 */
export const PENDING_REACTIVATION_REJECT_ERROR_CODES = [
  // invalid_body / invalid_input are blocked client-side (the reason field
  // is validated before submit) but kept here defensively — the route can
  // still return them. They reuse server_error copy via the t.has fallback,
  // so they are intentionally NOT required keys (see the test).
  'cycle_not_pending',
  'cycle_missing_invoice',
  'refund_failed',
  'rate_limited',
  'server_error',
] as const;

export type PendingReactivationRejectErrorCode =
  (typeof PENDING_REACTIVATION_REJECT_ERROR_CODES)[number];
