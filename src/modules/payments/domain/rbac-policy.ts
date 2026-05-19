/**
 * F5 RBAC policy matrix.
 *
 * Exported constants + pure authorisation helper for F5 resource
 * families (`payments:*`, `refunds:*`, `payment-settings:*`). Per Main-
 * agent Gate Decision #3, F1 has no existing matrix module — the F5
 * policy lives co-located with its own Domain so future route handlers
 * can import the narrowest surface they need without fabricating an
 * F1 infrastructure that other features would have to keep in sync.
 *
 * Authority: `specs/009-online-payment/security.md` § 4 RBAC matrix.
 *
 * Clean Architecture (Constitution Principle III): pure Domain — NO
 * framework / ORM / framework-runtime imports. Route handlers compose
 * this with session lookup from F1 at the Presentation layer.
 *
 * Ownership semantics: some rules require the acting member to own the
 * resource (e.g., a member can cancel ONLY their own pending payment).
 * The helper below resolves the ROLE question; the caller layers its
 * own ownership check on top (tenant_id match, member_id match). This
 * matches F1 precedent of separating "may this role touch this action?"
 * from "does this instance belong to them?".
 */

/** The role axis. Mirrors F1's `role` pg enum. */
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
