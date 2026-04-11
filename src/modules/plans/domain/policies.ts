/**
 * F2 Plans + Fee-config RBAC policies — thin wrappers that delegate to
 * F1's `canAccess(role, resource, action)` policy matrix.
 *
 * Why wrappers instead of duplicated logic:
 *   - F1's `canAccess` already encodes admin/manager/member semantics.
 *     F2 plan + fee_config rules are identical: admin full CRUD,
 *     manager read-only, member denied. Reimplementing would create
 *     two sources of truth.
 *   - The F1 `Resource` type uses `(string & {})` so we can pass
 *     `'plan'` and `'fee_config'` without widening the F1 union.
 *     T056 (Phase 2f) will optionally add them to the known literal
 *     list for IDE autocomplete — behaviour-identical.
 *
 * Pure TypeScript — no framework imports. Imports from the auth
 * module go through its public barrel.
 */

import { canAccess, type Role } from '@/modules/auth';

/**
 * Can `role` mutate a plan (create / update / activate / deactivate /
 * delete / undelete / clone)? Delegates to F1 policy.
 *
 * Rule (spec Q4): only `admin`. Managers are read-only; members denied.
 */
export function canAdminMutatePlan(role: Role): boolean {
  return canAccess(role, 'plan', 'write');
}

/**
 * Can `role` read plans? Admin + manager yes, member no (members
 * interact with plans via F3+ signup UI, not the staff surface).
 */
export function canReadPlan(role: Role): boolean {
  return canAccess(role, 'plan', 'read');
}

/** Alias used by the palette backend to filter "view" actions. */
export const canManagerReadPlan = canReadPlan;

/**
 * Can `role` clone plans from one year to another? Uses the dedicated
 * `'clone'` action (F2 addition to F1's Action union) — functionally
 * admin-only in F2, but distinct from `write` so future fine-grained
 * roles can grant clone without full mutation rights.
 */
export function canCloneYear(role: Role): boolean {
  return canAccess(role, 'plan', 'clone');
}

/**
 * Can `role` read the tenant fee config (currency / VAT / registration
 * fee)? Admin + manager yes.
 */
export function canReadFeeConfig(role: Role): boolean {
  return canAccess(role, 'fee_config', 'read');
}

/**
 * Can `role` mutate the tenant fee config? Admin only.
 */
export function canMutateFeeConfig(role: Role): boolean {
  return canAccess(role, 'fee_config', 'write');
}
