/**
 * F5 RBAC policy matrix — MEMBER-ARM VOCABULARY ONLY since 016.
 *
 * ## ⚠ Do NOT thread a staff session role into `isAllowed`
 *
 * 016 post-ship review (below-cap): this table predates RBAC v2 and was
 * never widened — `F5Role` has no `super_admin` and no `marketing`, so any
 * future caller that threads a REAL staff session role in here denies a
 * promoted super_admin (`['admin','manager'].includes('super_admin')` is
 * false — exactly the demotion class 016 T030 fixed everywhere else). Its
 * staff rows are also STALE AS DOCUMENTATION: `refunds.issue = ['admin']`
 * contradicts the live evaluator (`refunds.write` admits admin AND
 * super_admin). Staff authorization decisions belong to
 * `canPerform(role, key)` / `requireApiPermission` — never to this table.
 *
 * What keeps it alive: ONE production caller — `cancel-payment`'s
 * member-only `('payments', 'cancel-own')` arm, reached via
 * `requireMemberContext` (role is always the literal `'member'` there).
 * The staff-facing rows are dead code retained only because the D15-style
 * characterization tests pin the table's shape; treat them as history, not
 * as policy.
 *
 * Authority (historical): `specs/009-online-payment/security.md` § 4 —
 * superseded for staff access by the 016 permission catalogue.
 *
 * Clean Architecture (Constitution Principle III): pure Domain — NO
 * framework / ORM / framework-runtime imports.
 *
 * Ownership semantics: some rules require the acting member to own the
 * resource (e.g., a member can cancel ONLY their own pending payment).
 * The helper below resolves the ROLE question; the caller layers its
 * own ownership check on top (tenant_id match, member_id match).
 */

/**
 * The role axis. Pre-016 F1 enum — deliberately NOT widened (see the
 * header warning: staff decisions do not belong here).
 */
export type F5Role = 'member' | 'manager' | 'admin';

/** F5 resource families (spec security.md § 4). */
export type F5Resource =
  | 'payments'
  | 'refunds'
  | 'payment-settings'
  | 'online-payment-toggle';

/**
 * Actions the F5 feature exposes. Named after the HTTP verb intent so
 * route handlers can map 1:1 from `(resource, action)` to the allow
 * table without semantic mismatch.
 *
 * - `initiate`     — member-initiated payment intent creation
 * - `cancel-own`   — member cancelling their own pending payment
 * - `issue`        — admin issuing a refund
 * - `read-timeline` — admin/manager reading the payment timeline on an invoice
 * - `read-list`    — admin/manager listing invoices with `paid_online=true` filter
 * - `read-own`     — member viewing their own payment history
 * - `update`       — admin updating tenant_payment_settings
 * - `toggle-online`— admin flipping `online_payment_enabled`
 */
export type F5Action =
  | 'initiate'
  | 'cancel-own'
  | 'issue'
  | 'read-timeline'
  | 'read-list'
  | 'read-own'
  | 'update'
  | 'toggle-online';

/**
 * Policy table — each (resource, action) maps to the set of roles
 * allowed to perform it. Empty set ≡ nobody (route returns 403).
 *
 * Ownership constraints (e.g. "own payment only") are enforced by the
 * caller after this policy check; the table ONLY answers the role
 * question per spec § 4.
 */
export const F5_POLICIES: Readonly<
  Record<F5Resource, Readonly<Record<F5Action, readonly F5Role[]>>>
> = Object.freeze({
  payments: Object.freeze({
    initiate: ['member'] as const,
    'cancel-own': ['member'] as const,
    issue: [] as const,
    'read-timeline': ['admin', 'manager'] as const,
    'read-list': ['admin', 'manager'] as const,
    'read-own': ['member'] as const,
    update: [] as const,
    'toggle-online': [] as const,
  }),
  refunds: Object.freeze({
    initiate: [] as const,
    'cancel-own': [] as const,
    issue: ['admin'] as const,
    'read-timeline': ['admin', 'manager'] as const,
    'read-list': ['admin', 'manager'] as const,
    'read-own': [] as const,
    update: [] as const,
    'toggle-online': [] as const,
  }),
  'payment-settings': Object.freeze({
    initiate: [] as const,
    'cancel-own': [] as const,
    issue: [] as const,
    'read-timeline': [] as const,
    'read-list': ['admin'] as const,
    'read-own': [] as const,
    update: ['admin'] as const,
    'toggle-online': [] as const,
  }),
  'online-payment-toggle': Object.freeze({
    initiate: [] as const,
    'cancel-own': [] as const,
    issue: [] as const,
    'read-timeline': [] as const,
    'read-list': [] as const,
    'read-own': [] as const,
    update: [] as const,
    'toggle-online': ['admin'] as const,
  }),
});

/**
 * Pure role-gate check. Returns `true` if the role is ALLOWED to
 * perform `action` on `resource` per the F5 policy table.
 *
 * **Does NOT check ownership** — callers MUST additionally verify
 * that the acting user owns/controls the target instance (e.g., the
 * payment belongs to the member's tenant + their own company invoice).
 * F1's session + tenant context supplies those fields.
 *
 * Returns `false` for any unknown role/resource/action combination so
 * forgetting to add a new entry fails closed.
 */
export function isAllowed(
  role: F5Role,
  resource: F5Resource,
  action: F5Action,
): boolean {
  // Use `Object.hasOwn` instead of a truthy check so the fail-closed
  // branches can be covered by tests WITHOUT casting runtime-impossible
  // values through `as unknown as F5Resource` (audit 2026-04-25
  // finding #5). `hasOwn` returns false for any key not declared in
  // F5_POLICIES at compile time, which is exactly what we want for the
  // fails-closed guarantee.
  if (!Object.hasOwn(F5_POLICIES, resource)) return false;
  const resourcePolicy = F5_POLICIES[resource];
  if (!Object.hasOwn(resourcePolicy, action)) return false;
  const allowedRoles = resourcePolicy[action];
  return allowedRoles.includes(role);
}
