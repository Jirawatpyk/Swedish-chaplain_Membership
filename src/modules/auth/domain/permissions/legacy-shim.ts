/**
 * Legacy-leg compatibility shim — D16 totalisation + shim row primitives
 * (016-rbac-permissions; design § 6.1, contracts/permission-evaluator.md § 3).
 *
 * TEMPORARY by design: the whole file is deleted in PR 5 together with the
 * legacy evaluator leg, `canAccess` façade, and the `FEATURE_RBAC_V2` env read.
 *
 * Rows are selected PER CALL SITE (per call-site class, never per key — one
 * key may span several rows; round-3 Criticals R3-1/R3-01). PR 1 ships the
 * row PRIMITIVES + D16 normalisation; PR 2 (T022) pins the full row table
 * per surface, with `legacySessionOnly` restricted to the 17 pages pinned in
 * contracts/authorization-surfaces § 1.1 and `legacyAdminOrManager` for the
 * 8 A* inert-check pages.
 *
 * Pure Domain — no framework imports; the flag never enters this file.
 */

import type { Action, Resource } from '../policies';
import { canAccess } from '../policies';
import type { Role } from '../role';

/** A flag-OFF shim row: how ONE call-site class was guarded pre-cutover. */
export type LegacyRow =
  | { readonly kind: 'legacySessionOnly' }
  | { readonly kind: 'legacyAdminOrManager' }
  | { readonly kind: 'legacyAdminOnly' }
  | { readonly kind: 'legacyF6Guard' }
  | { readonly kind: 'mappedLegacy'; readonly resource: Resource; readonly action: Action };

/** The 17 contracts § 1.1 pure session-only pages: any staff session passes. */
export const legacySessionOnly: LegacyRow = { kind: 'legacySessionOnly' };

/**
 * The 8 contracts § 1.1 A* pages whose inert `admin || manager` deny-arm is
 * the observed gate. After D16 normalisation this is extensionally identical
 * to `legacySessionOnly` (super_admin→admin passes; marketing/unknown denied)
 * but the distinct row keeps the characterization capture honest per class.
 */
export const legacyAdminOrManager: LegacyRow = { kind: 'legacyAdminOrManager' };

/**
 * The 21 contracts § 1.1 Class-B pages whose observed gate is a bare
 * `role !== 'admin' → notFound()` literal — no `canAccess` call to delegate
 * to, so this cannot be expressed as a `mappedLegacy` row.
 */
export const legacyAdminOnly: LegacyRow = { kind: 'legacyAdminOnly' };

/**
 * The 16 F6 route handlers guarded by `adminOnlyWriterGuard` (events) or
 * `adminOnlyGuard` (eventcreate integration) — the D9 permanent route-local
 * override that survives PR 5.
 *
 * Evaluates identically to `legacyAdminOnly`; the distinct kind records that
 * the DENIAL SHAPE differs and is contractual (manager → 403 + RFC 7807 +
 * `role_violation_blocked` audit; member/unknown → 404), so a future edit that
 * collapses the two rows is visible in review.
 *
 * Both guards today compare `role === 'admin'` and fail closed on anything
 * else, which would 404 every promoted `super_admin` after Migration C. T029
 * admits `super_admin` in both guards; this row already encodes the contract
 * (`super_admin` evaluates as `admin` per D16), so the matrix holds the code
 * to it rather than the other way round.
 */
export const legacyF6Guard: LegacyRow = { kind: 'legacyF6Guard' };

/** A call site guarded today by `canAccess(role, resource, action)`. */
export function mappedLegacy(resource: Resource, action: Action): LegacyRow {
  return { kind: 'mappedLegacy', resource, action };
}

/** The roles the pre-016 system knows. */
export type LegacyRole = 'admin' | 'manager' | 'member';

/**
 * D16 totalisation: how the two NEW roles evaluate while the flag is OFF.
 *
 *   - `super_admin` → `admin` semantics (capability-preserving degrade)
 *   - `marketing`   → null = DENIED on every staff surface. NEVER mapped to
 *     manager: that would GRANT marketing the manager money-read surface
 *     during an emergency flag-OFF after PR 4 (round-3 SEC-R3-03; the
 *     availability cost is accepted and runbook-noted).
 *   - unknown/future values → null (deny; never escalate).
 */
export function normalizeLegacyRole(role: Role | (string & {})): LegacyRole | null {
  switch (role) {
    case 'super_admin':
      return 'admin';
    case 'marketing':
      return null;
    case 'admin':
      return 'admin';
    case 'manager':
      return 'manager';
    case 'member':
      return 'member';
    default:
      return null;
  }
}

/** Evaluate one shim row for one actor — the flag-OFF leg's entire logic. */
export function evaluateLegacyRow(role: Role | (string & {}), row: LegacyRow): boolean {
  const normalized = normalizeLegacyRole(role);
  if (normalized === null) return false;
  switch (row.kind) {
    case 'legacySessionOnly':
    case 'legacyAdminOrManager':
      // Both admit exactly the staff roles the pre-016 layout admitted
      // (member is ejected by the staff-shell redirect today).
      return normalized === 'admin' || normalized === 'manager';
    case 'legacyAdminOnly':
    case 'legacyF6Guard':
      return normalized === 'admin';
    case 'mappedLegacy':
      return canAccess(normalized, row.resource, row.action);
  }
}
