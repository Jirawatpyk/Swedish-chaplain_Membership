/**
 * DV-5 — canonical lists of error codes the cancel-cycle + mark-paid-offline
 * routes emit in `{ error: { code } }`, surfaced as toasts by
 * `CycleAdminActions` via `t(\`cancelCycle.error.${code}\`)` /
 * `t(\`markPaidOffline.error.${code}\`)`.
 *
 * Single-sourced so the i18n-coverage unit test
 * (`cycle-admin-error-i18n.test.ts`) can assert every listed code has a
 * non-empty EN key under the matching namespace. The component guards each
 * lookup with `t.has(...)` + a `server_error` fallback, so an UNKNOWN/omitted
 * code degrades gracefully to generic copy. Each list below is the subset of a
 * route's emittable codes that warrants its OWN copy; the per-list doc says
 * which codes are intentionally omitted (and why) and which route sources to
 * keep in sync with:
 *   - src/app/api/admin/renewals/[cycleId]/cancel/route.ts
 *   - src/app/api/admin/renewals/[cycleId]/mark-paid-offline/route.ts
 *   - src/lib/renewals-route-helpers.ts (requireRenewalAdminContext)
 */

/**
 * Cancel-cycle route error codes that warrant their OWN toast copy.
 *
 * Intentionally OMITTED (degrade to `server_error` copy via the `t.has`
 * fallback): `invalid_input` AND `invalid_body` — the cancel reason is fully
 * client-validated (1..500) before submit and the confirm button is disabled
 * while invalid, so the route's body-validation codes are unreachable from
 * this UI. `feature_disabled` (503) maps to its own copy. `no_session` (401,
 * session expired mid-dialog) + `forbidden` (403, role lost write permission)
 * ARE reachable and get actionable copy.
 *
 * Keep in sync with every code the route can emit:
 *   - pre-switch guards (cancel/route.ts): `feature_disabled`, `invalid_body`
 *   - `requireRenewalAdminContext`: `no_session`, `forbidden`
 *   - the use-case `switch` arms (cancel/route.ts)
 */
export const CANCEL_CYCLE_ERROR_CODES = [
  'cycle_not_found',
  'cycle_not_cancellable',
  'no_session',
  'forbidden',
  'feature_disabled',
  'server_error',
] as const;

/**
 * Mark-paid-offline route error codes that warrant their OWN toast copy.
 *
 * `invalid_input` degrades to `server_error` copy (not a required key), but
 * `invalid_body` IS listed: unlike cancel's fully-client-validated reason, the
 * server-only PAN-guard (a 13+ digit `payment_reference`) can reject a body
 * that passed the client's required-field check, so `invalid_body` is
 * reachable here. `f4_orphan_invoice` additionally renders a DO-NOT-RETRY
 * message + a deep-link to the orphan invoice. `no_session` + `forbidden`
 * mirror the cancel list (reachable auth failures with actionable copy).
 *
 * Keep in sync with every code the route can emit:
 *   - pre-switch guards (mark-paid-offline/route.ts): `feature_disabled`,
 *     `invalid_body`
 *   - `requireRenewalAdminContext`: `no_session`, `forbidden`
 *   - the use-case `switch` arms (mark-paid-offline/route.ts)
 */
export const MARK_PAID_OFFLINE_ERROR_CODES = [
  'cycle_not_found',
  'cycle_not_payable',
  'f4_orphan_invoice',
  'f4_failure',
  'invalid_body',
  'no_session',
  'forbidden',
  'feature_disabled',
  'server_error',
] as const;

/**
 * Mark-paid-offline DO-NOT-RETRY routing. When the route returns
 * `f4_orphan_invoice` (an invoice WAS issued but the cycle flip failed), the
 * toast must deep-link the admin to that invoice so they can resume from the
 * F4 list instead of retrying (a retry would double-issue). Returns the
 * encoded invoice href, or `null` for any other error (the caller then falls
 * through to the generic `error.<code>` toast).
 *
 * Pure so the exact gate (code AND id both present) + the `encodeURIComponent`
 * href construction are unit-testable WITHOUT rendering the Base UI dialog
 * (which deadlocks under jsdom + React 19 `startTransition`) and without the
 * fault injection a real-error E2E would need.
 */
export function resolveOrphanInvoiceHref(err: {
  readonly code: string;
  readonly orphan_invoice_id?: string;
}): string | null {
  if (err.code === 'f4_orphan_invoice' && err.orphan_invoice_id) {
    return `/admin/invoices/${encodeURIComponent(err.orphan_invoice_id)}`;
  }
  return null;
}
