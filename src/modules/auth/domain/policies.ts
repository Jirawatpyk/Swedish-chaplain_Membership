/**
 * RBAC policy: `canAccess(role, resource, action)` (T033, spec Q4 / FR-003).
 *
 * Encodes the three-role permission matrix as pure data. Used by:
 *   - Application use cases (`has-permission` helper)
 *   - `src/lib/rbac-guard.ts` (API routes: enforces 403 + emits
 *     `manager_denied_write`). NOTE: the original plan put this in
 *     `middleware.ts` / `proxy.ts`, but Edge runtime can't read
 *     Postgres or write audit rows — see `rbac-guard.ts` file header
 *     for the deviation rationale.
 *   - UI (server components conditionally render destructive actions)
 *
 * The single hard rule (spec Q4):
 *   - **manager** is read-only EVERYWHERE except for self-service:
 *     they may change their own password, sign out, and complete
 *     their own profile (when F3 lands). Any other write → 403.
 *
 * Pure functions — Domain layer; no framework imports.
 */

import type { Role } from './role';

export type Action = 'read' | 'write' | 'delete' | 'admin';

/**
 * F1 currently treats every protected resource as a single category.
 * Phase 2 features (members, invoices, events) will introduce more
 * specific resource ids; the policy function accepts a string so it
 * remains forward-compatible without a domain-wide enum.
 *
 * Recognised F1 resource ids (suggested):
 *   - 'auth:self'           — own account (sign-out, change password)
 *   - 'auth:user'           — other accounts (admin lifecycle ops)
 *   - 'auth:audit'          — audit log viewer
 *   - 'staff:dashboard'     — staff home / read-only browsing
 *   - 'member:portal'       — member portal landing
 */
export type Resource = string;

/** Self-service resource id — actions on the actor's OWN account. */
export const SELF_RESOURCE: Resource = 'auth:self';

/**
 * Decide whether `role` may perform `action` on `resource`.
 *
 * Rules (spec § Clarifications Q4):
 *   1. admin   → all actions on all resources
 *   2. manager → all reads; writes ONLY on `auth:self`
 *   3. member  → reads on `member:*` resources; writes ONLY on `auth:self`
 *
 * The policy is intentionally simple — F1 is small enough that an
 * explicit table is clearer than a rule engine.
 */
export function canAccess(role: Role, resource: Resource, action: Action): boolean {
  // Self-service is always allowed for the owning role.
  if (resource === SELF_RESOURCE) {
    return action === 'read' || action === 'write';
  }

  if (role === 'admin') {
    return true;
  }

  if (role === 'manager') {
    // Read everything; never mutate (spec Q4 — "manager read-only").
    return action === 'read';
  }

  // member: F1 only exposes the member portal landing page (placeholder).
  if (role === 'member') {
    if (resource.startsWith('member:')) {
      return action === 'read';
    }
    // Members may NOT browse staff resources or audit logs.
    return false;
  }

  return false;
}

/**
 * Convenience: is this role allowed to mutate ANY resource other than
 * their own account? Used by `rbac-guard.ts` to short-circuit the
 * policy check for read-only roles on write paths.
 */
export function isReadOnlyRole(role: Role): boolean {
  return role === 'manager' || role === 'member';
}
