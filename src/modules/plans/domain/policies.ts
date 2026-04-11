/**
 * F2 Plans + Fee-config RBAC policies.
 *
 * Implements the admin/manager/member matrix for plan + fee_config
 * resources inline. The rules are trivial (admin full, manager read
 * only, member denied) and match F1's `canAccess` semantics — the F1
 * function is the authoritative source-of-truth for the identity
 * surface (auth:self, auth:user, auth:audit, staff:dashboard,
 * member:portal), and this file mirrors the same decision for the F2
 * resources.
 *
 * **Why inline instead of delegating to F1's canAccess**:
 *   - `@/modules/plans` is imported by client components (e.g.
 *     `LocaleTextDisplay`). If this Domain file imported `canAccess`
 *     at runtime from `@/modules/auth`, the auth barrel's use-case
 *     re-exports would chain-pull `@node-rs/argon2` (a Node-only
 *     native binding) into the client bundle, breaking every plans
 *     page with a Next.js "Module not found" error at turbopack
 *     build time. Verified by `/speckit.qa` on 2026-04-11 against
 *     the running dev server — the error reproduces on every visit
 *     to `/admin/plans` until the runtime import is removed.
 *   - F1's own `canAccess` is ~10 lines. Duplicating the
 *     "admin=yes, manager=read, member=no" semantics for 2 resources
 *     is cheaper than the bundler hazard.
 *   - F1 role-policies tests still cover F1 semantics and do not
 *     need to change.
 *   - `Role` is imported type-only (erased at compile time, no
 *     bundler impact) from the deep path `@/modules/auth/domain/role`
 *     which is framework-free and safe for the client bundle.
 *
 * Pure TypeScript. Zero runtime imports from other modules.
 */

import type { Role } from '@/modules/auth/domain/role';

/**
 * Can `role` mutate a plan (create / update / activate / deactivate /
 * delete / undelete / clone)?
 *
 * Rule (spec Q4): only `admin`. Managers are read-only; members denied.
 */
export function canAdminMutatePlan(role: Role): boolean {
  return role === 'admin';
}

/**
 * Can `role` read plans? Admin + manager yes, member no (members
 * interact with plans via F3+ signup UI, not the staff surface).
 */
export function canReadPlan(role: Role): boolean {
  return role === 'admin' || role === 'manager';
}

/** Alias used by the palette backend to filter "view" actions. */
export const canManagerReadPlan = canReadPlan;

/**
 * Can `role` clone plans from one year to another? Clone is an
 * admin-only action (mirrors F1's canAccess with the `'clone'` action
 * added in T056).
 */
export function canCloneYear(role: Role): boolean {
  return role === 'admin';
}

/**
 * Can `role` read the tenant fee config (currency / VAT / registration
 * fee)? Admin + manager yes.
 */
export function canReadFeeConfig(role: Role): boolean {
  return role === 'admin' || role === 'manager';
}

/**
 * Can `role` mutate the tenant fee config? Admin only.
 */
export function canMutateFeeConfig(role: Role): boolean {
  return role === 'admin';
}
