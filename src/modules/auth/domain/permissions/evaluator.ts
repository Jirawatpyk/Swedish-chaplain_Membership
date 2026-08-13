/**
 * Permission evaluator — pure Domain, single leg
 * (016-rbac-permissions; contracts/permission-evaluator.md § 1, guarantees E1–E6).
 *
 * PR 5 (T068) deleted the legacy leg: production has run the positive-
 * permission leg since the 2026-08-11 cutover, PR 4 flipped the code default,
 * and the `FEATURE_RBAC_V2` flag no longer exists. The `EvaluatorOptions`
 * parameter went with it — the evaluator needs nothing beyond (role, key),
 * which also dissolves the old purity hazard (the flag used to be threaded in
 * from the composition layer; now there is nothing to thread).
 *
 * Signature is ROLE-FIRST (canonical, data-model § 1): the super_admin bypass
 * (E1) needs the role — a bare permission set cannot express it.
 */

import type { Role } from '../role';
import {
  ALL_PERMISSION_KEYS,
  SUPER_ADMIN_ONLY_KEYS,
  type PermissionKey,
} from './permission-catalogue';
import { ROLE_BUNDLES } from './role-bundles';

const EMPTY_SET: ReadonlySet<PermissionKey> = new Set();

/**
 * Derived, in-memory permission set for a role (D15: synchronous, no DB read,
 * never persisted). Feeds nav/palette filtering. `super_admin` derives the
 * FULL catalogue — the E1 bypass surfaced as data so permission-aware UI
 * shows the complete surface. Unknown/future roles derive the empty set.
 */
export function getPermissionSet(role: Role | (string & {})): ReadonlySet<PermissionKey> {
  if (role === 'super_admin') return ALL_PERMISSION_KEYS;
  return lookupBundle(ROLE_BUNDLES, role) ?? EMPTY_SET;
}

/**
 * Own-property-only bundle lookup. A plain object literal inherits
 * `Object.prototype`, so a bare `bundles[role]` for a role string like
 * `'toString'` or `'__proto__'` returns a Function/prototype instead of
 * `undefined` — the `??` fallbacks never fire and `.has()` throws, breaking
 * the E6 "never throws, never escalates" guarantee for arbitrary strings.
 */
function lookupBundle(
  bundles: Record<Role, ReadonlySet<PermissionKey>>,
  role: Role | (string & {}),
): ReadonlySet<PermissionKey> | undefined {
  return Object.hasOwn(bundles, role)
    ? (bundles as Record<string, ReadonlySet<PermissionKey>>)[role]
    : undefined;
}

/**
 * The single authorization decision:
 *
 *   E1  super_admin        → true (total bypass)
 *   E2  superAdminOnly key → false for every other role, even if a (buggy)
 *       bundle contains it — checked BEFORE bundle lookup
 *   E3  bundle membership (§ 4.1 matrix parity)
 *   E5  deterministic, synchronous, no I/O
 *   E6  unknown/future role → false; never throws, never escalates
 *
 * (E4 — the flag-OFF legacy shim leg — was deleted in PR 5 with the flag.)
 *
 * `bundles` is injectable for Domain tests only (E2 poisoned-bundle proof);
 * production call sites never pass it.
 */
export function hasPermission(
  role: Role | (string & {}),
  key: PermissionKey,
  bundles: Record<Role, ReadonlySet<PermissionKey>> = ROLE_BUNDLES,
): boolean {
  if (role === 'super_admin') return true;
  if (SUPER_ADMIN_ONLY_KEYS.has(key)) return false;
  return lookupBundle(bundles, role)?.has(key) ?? false;
}
