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

/**
 * Policy actions. F1 baseline: read/write/delete/admin.
 * F2 (002-membership-plans) adds `'clone'` for the year-clone
 * operation — functionally `admin only` in F2, but distinct from
 * `write` so a future fine-grained role (e.g. "catalogue editor")
 * could be granted clone without full mutation rights.
 */
export type Action = 'read' | 'write' | 'delete' | 'admin' | 'clone';

/**
 * Known resource identifiers. The literal union gives IDE
 * autocomplete + catches typos in policy call sites, while the
 * `(string & {})` tail keeps the type forward-compatible: F3+
 * features can still pass resource ids that don't appear here
 * (e.g. `'members:list'`, `'invoices:read'`) without having to
 * widen the union file-by-file.
 *
 * The TS `(string & {})` trick is the standard pattern for
 * "known literals with autocomplete + arbitrary-string fallback"
 * — the intersection prevents the literals from being widened
 * away by the compiler but accepts any string at the value level.
 *
 * Recognised F1 resource ids:
 *   - 'auth:self'           — own account (sign-out, change password)
 *   - 'auth:user'           — other accounts (admin lifecycle ops)
 *   - 'auth:audit'          — audit log viewer
 *   - 'staff:dashboard'     — staff home / read-only browsing
 *   - 'member:portal'       — member portal landing
 *
 * F2 resource ids (added by 002-membership-plans):
 *   - 'plan'                — membership plan catalogue (CRUD + clone)
 *   - 'fee_config'          — per-tenant currency/VAT/registration fee
 *
 * F3 resource ids (added by 005-members-contacts):
 *   - 'members'             — member directory + detail (admin CRUD, manager R)
 *   - 'members:bulk'        — bulk actions (FR-019, admin-only)
 *   - 'members:own'         — the acting member's own profile (member R+W
 *                             on whitelisted fields per FR-014a)
 *   - 'contacts'            — contact CRUD on any member (admin RW, manager R)
 *   - 'contacts:own'        — member self-service contact edit (whitelisted fields)
 *
 * F4 resource ids (added by 007-invoices-receipts):
 *   - 'invoice'             — invoice CRUD (admin RW, manager R, member R own)
 *   - 'credit_note'         — credit note CRUD (admin RW, manager R)
 *   - 'tenant_invoice_settings' — tenant tax/numbering/logo config (admin RW)
 *
 * F5 resource ids (added by 009-online-payment Phase 6):
 *   - 'refund'              — admin-initiated refund issuance (admin only;
 *                             manager + member denied — refunds touch real
 *                             money + an append-only F4 credit note)
 */
export type Resource =
  | 'auth:self'
  | 'auth:user'
  | 'auth:audit'
  | 'staff:dashboard'
  | 'member:portal'
  | 'plan'
  | 'fee_config'
  | 'members'
  | 'members:bulk'
  | 'members:own'
  | 'contacts'
  | 'contacts:own'
  | 'invoice'
  | 'credit_note'
  | 'tenant_invoice_settings'
  | 'refund'
  | (string & {});

/** Self-service resource id — actions on the actor's OWN account. */
export const SELF_RESOURCE: Resource = 'auth:self';

/**
 * Decide whether `role` may perform `action` on `resource`.
 *
 * Rules (spec § Clarifications Q4, extended by F2):
 *   1. admin   → all actions on all resources (including `clone` on `plan`)
 *   2. manager → all reads; writes ONLY on `auth:self`
 *   3. member  → reads on `member:*` resources; writes ONLY on `auth:self`
 *
 * F2 additions:
 *   - `plan` / `fee_config` inherit the baseline rules — admin gets
 *     every action, manager gets read-only, member is denied entirely
 *     (the staff surface is not exposed to member accounts).
 *   - `clone` is an admin-only action on `plan`. Non-`plan` resources
 *     do not accept `clone` — it returns false for anything else.
 *
 * The policy is intentionally simple — an explicit table is clearer
 * than a rule engine at this scale.
 */
export function canAccess(role: Role, resource: Resource, action: Action): boolean {
  // Self-service is always allowed for the owning role.
  if (resource === SELF_RESOURCE) {
    return action === 'read' || action === 'write';
  }

  if (role === 'admin') {
    // F3 bulk: admin-only; other actions on bulk are meaningless.
    if (resource === 'members:bulk') return action === 'write';
    return true;
  }

  if (role === 'manager') {
    // F3: manager is read-only on the member directory + contacts.
    // Never bulk, never write, never delete.
    if (resource === 'members:bulk') return false;
    // Read everything; never mutate (spec Q4 — "manager read-only").
    return action === 'read';
  }

  // member: F1 only exposes the member portal landing page (placeholder).
  // F2: members are blocked from the staff catalogue surface entirely.
  // F3: members may read+write (whitelisted fields) on their OWN
  //     profile + contact. Cross-member reads + directory reads are denied.
  if (role === 'member') {
    if (resource === 'members:own' || resource === 'contacts:own') {
      return action === 'read' || action === 'write';
    }
    if (resource.startsWith('member:')) {
      return action === 'read';
    }
    // Members may NOT browse staff resources, audit logs, plans, or
    // the full member/contact directory.
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
