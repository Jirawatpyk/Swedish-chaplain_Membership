/**
 * Permission evaluator — pure Domain, both flag legs
 * (016-rbac-permissions; contracts/permission-evaluator.md § 1, guarantees E1–E6).
 *
 * PURITY PIN (design § 6.1, round-3 R3-04): the flag is ALWAYS an explicit
 * parameter. The only `FEATURE_RBAC_V2` env reads live in `src/lib/rbac.ts`
 * (PR 2) — never here, never in client components (they receive server-derived
 * booleans as props). `src/modules/plans` deep-imports THIS module (not the
 * auth barrel — argon2 client-bundle hazard) and threads the flag from its own
 * server boundary.
 *
 * Signature is ROLE-FIRST (canonical, data-model § 1): the super_admin bypass
 * (E1) and D16 totalisation (E4) both need the role — a bare permission set
 * can express neither.
 */

import type { Role } from '../role';
import { evaluateLegacyRow, type LegacyRow } from './legacy-shim';
import {
  ALL_PERMISSION_KEYS,
  SUPER_ADMIN_ONLY_KEYS,
  type PermissionKey,
} from './permission-catalogue';
import { ROLE_BUNDLES } from './role-bundles';

const EMPTY_SET: ReadonlySet<PermissionKey> = new Set();

export interface EvaluatorOptions {
  /** The FEATURE_RBAC_V2 flag — threaded in by the caller, never read here. */
  readonly rbacV2: boolean;
  /**
   * Flag-OFF leg only: the shim row for the CALLING call-site class
   * (contract § 3 — rows are per call-site class, selected by the caller).
   * Absent row on the legacy leg → deny (safe default).
   */
  readonly legacy?: LegacyRow;
}

/**
 * Derived, in-memory permission set for a role (D15: synchronous, no DB read,
 * never persisted). Feeds nav/palette filtering. `super_admin` derives the
 * FULL catalogue — the E1 bypass surfaced as data so permission-aware UI
 * shows the complete surface. Unknown/future roles derive the empty set.
 */
export function getPermissionSet(role: Role | (string & {})): ReadonlySet<PermissionKey> {
  if (role === 'super_admin') return ALL_PERMISSION_KEYS;
  const bundle = (ROLE_BUNDLES as Partial<Record<string, ReadonlySet<PermissionKey>>>)[
    role
  ];
  return bundle ?? EMPTY_SET;
}

/**
 * The single authorization decision, total over both legs:
 *
 *   E1  flag ON  + super_admin        → true (total bypass)
 *   E2  flag ON  + superAdminOnly key → false for every other role, even if a
 *       (buggy) bundle contains it — checked BEFORE bundle lookup
 *   E3  flag ON  → bundle membership (§ 4.1 matrix parity)
 *   E4  flag OFF → D16 totalisation + the caller's shim row; no row → false
 *   E5  deterministic, synchronous, no I/O
 *   E6  unknown/future role → false on either leg; never throws, never escalates
 *
 * `bundles` is injectable for Domain tests only (E2 poisoned-bundle proof);
 * production call sites never pass it.
 */
export function hasPermission(
  role: Role | (string & {}),
  key: PermissionKey,
  opts: EvaluatorOptions,
  bundles: Record<Role, ReadonlySet<PermissionKey>> = ROLE_BUNDLES,
): boolean {
  if (!opts.rbacV2) {
    return opts.legacy === undefined ? false : evaluateLegacyRow(role, opts.legacy);
  }
  if (role === 'super_admin') return true;
  if (SUPER_ADMIN_ONLY_KEYS.has(key)) return false;
  const bundle = (bundles as Partial<Record<string, ReadonlySet<PermissionKey>>>)[role];
  return bundle?.has(key) ?? false;
}
