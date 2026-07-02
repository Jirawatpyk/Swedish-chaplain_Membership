/**
 * Create-plan API error code → `admin.plans.errors.*` i18n key.
 *
 * `POST /api/plans` returns snake_case error codes (see
 * `src/app/api/plans/route.ts`). `new-plan-client` looks up
 * `admin.plans.errors.<code>` and falls back to `errors.generic` on a miss.
 * These codes either differ in spelling from their same-named i18n key or
 * have no matching key, so without this map they render the generic toast:
 *   - `duplicate_plan`                 → `duplicateKey`
 *   - `idempotency_conflict`           → `idempotencyConflict`
 *   - `invalid_body`                   → `validation`  (schema/shape failure)
 *   - `partnership_corporate_mismatch` → `validation`  (integrity-rule failure)
 *
 * `invalid_body` / `partnership_corporate_mismatch` are near-unreachable via
 * the wizard (client-side zod validates first); they share the `validation`
 * message as a defensive fallback for direct API calls / schema drift.
 * Unknown / already-matching codes pass through unchanged (caller then falls
 * back to `errors.generic`).
 *
 * Kept as a pure, colocated module so the mapping is unit-tested without
 * rendering the client (tests/unit/app/admin/plans/new-plan-error-key.test.ts).
 * Surfaced by F2 UAT TC-PLAN-14; `duplicate_plan` first fixed in PR #137.
 */
export const PLAN_CREATE_ERROR_KEY_MAP: Readonly<Record<string, string>> = {
  duplicate_plan: 'duplicateKey',
  idempotency_conflict: 'idempotencyConflict',
  invalid_body: 'validation',
  partnership_corporate_mismatch: 'validation',
};

/**
 * Resolve a create-plan API error code to its i18n key. Returns the code
 * unchanged when it is not in the map (identity), so callers can keep their
 * `key in errors` lookup + generic fallback.
 */
export function resolvePlanCreateErrorKey(apiCode: string): string {
  return PLAN_CREATE_ERROR_KEY_MAP[apiCode] ?? apiCode;
}
