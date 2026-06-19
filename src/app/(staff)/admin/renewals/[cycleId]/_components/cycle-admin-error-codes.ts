/**
 * DV-5 — canonical lists of error codes the cancel-cycle + mark-paid-offline
 * routes emit in `{ error: { code } }`, surfaced as toasts by
 * `CycleAdminActions` via `t(\`cancelCycle.error.${code}\`)` /
 * `t(\`markPaidOffline.error.${code}\`)`.
 *
 * Single-sourced so the i18n-coverage unit test
 * (`cycle-admin-error-i18n.test.ts`) can assert every code has a non-empty
 * EN key under the matching namespace. The component guards each lookup with
 * `t.has(...)` + a `server_error` fallback, so an UNKNOWN future code degrades
 * gracefully — but each code listed here is one the route ACTUALLY returns, so
 * each must resolve to its own copy. Keep in sync with the `switch` arms in:
 *   - src/app/api/admin/renewals/[cycleId]/cancel/route.ts
 *   - src/app/api/admin/renewals/[cycleId]/mark-paid-offline/route.ts
 */

/**
 * Cancel-cycle route error codes. `invalid_input` is blocked client-side (the
 * reason field is validated before submit) but the route can still return it;
 * it degrades to server_error copy via the `t.has` fallback, so it is
 * intentionally NOT a required key. `feature_disabled` (503) maps to its own
 * copy.
 */
export const CANCEL_CYCLE_ERROR_CODES = [
  'cycle_not_found',
  'cycle_not_cancellable',
  'feature_disabled',
  'server_error',
] as const;

export type CancelCycleErrorCode = (typeof CANCEL_CYCLE_ERROR_CODES)[number];

/**
 * Mark-paid-offline route error codes. `invalid_input` degrades to
 * server_error copy via the `t.has` fallback (not a required key); the rest
 * each get their own copy. `f4_orphan_invoice` additionally renders a
 * DO-NOT-RETRY message + a deep-link to the orphan invoice.
 */
export const MARK_PAID_OFFLINE_ERROR_CODES = [
  'cycle_not_found',
  'cycle_not_payable',
  'f4_orphan_invoice',
  'f4_failure',
  'invalid_body',
  'feature_disabled',
  'server_error',
] as const;

export type MarkPaidOfflineErrorCode =
  (typeof MARK_PAID_OFFLINE_ERROR_CODES)[number];
