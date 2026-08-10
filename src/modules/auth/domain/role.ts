/**
 * Role enum and portal mapping (data-model.md § 2.1, spec Q4;
 * widened to five roles by 016-rbac-permissions FR-001).
 *
 * Five roles exactly: super_admin, admin, manager, marketing, member.
 * They are NEVER combined (1 user = 1 role).
 * Pure TypeScript — Domain layer; no framework imports.
 *
 * Tuple order mirrors the Postgres enum label order after migration 0285
 * (ADD VALUE appends): the original three labels first, then the two 016
 * additions. Never reorder — schema.ts `roleEnum` must match label-for-label.
 */

export const ROLES = ['admin', 'manager', 'member', 'super_admin', 'marketing'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles that staff UI may OFFER for assignment/invitation right now.
 * Deliberately narrower than ROLES while 016 rolls out: `super_admin`
 * becomes assignable in PR 3 (users-page retrofit), `marketing` in PR 4
 * (design § 9 / D17). The invite API's zod schema is the server-side
 * counterpart — widen both together, never just one.
 */
export const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'manager', 'member'];

/**
 * The two portal surfaces the app renders: `staff` (backoffice,
 * role=admin/manager) and `member` (self-service, role=member).
 *
 * Lives in Domain because the mapping is a business invariant
 * (spec Q2: "staff members who are also TSCC members keep separate
 * accounts"). URL-path concerns are a Presentation detail and live
 * in `src/lib/portal-paths.ts`.
 */
export type Portal = 'staff' | 'member';

/** Roles that sign in via /admin (the staff portal). */
export const STAFF_ROLES: readonly Role[] = ['super_admin', 'admin', 'manager', 'marketing'];

/**
 * Which portal a given role lands on after sign-in.
 *
 * - super_admin / admin / manager / marketing → 'staff' (`/admin/**`)
 * - member                                    → 'member' (`/portal/**`)
 *
 * Cross-portal sign-in is rejected with the same generic
 * `invalid-credentials` message used for wrong passwords (spec FR-016)
 * so the response doesn't leak which portal an account belongs to.
 */
export const PORTAL_FOR_ROLE: Record<Role, Portal> = {
  super_admin: 'staff',
  admin: 'staff',
  manager: 'staff',
  marketing: 'staff',
  member: 'member',
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isStaffRole(role: Role): boolean {
  return STAFF_ROLES.includes(role);
}

/**
 * Roles that carry administrative capability over the tenant — the population
 * the last-administrator guard protects. The set DEPENDS ON THE FLAG, because
 * what "can administer this tenant" means changes at cutover:
 *
 *   flag OFF — `super_admin` ∪ `admin`. A plain admin still holds every
 *     administrative capability, so refusing a demotion while other admins
 *     remain would block ordinary day-to-day operations. Matches the
 *     transitional population inside `users_last_admin_guard()` (migration
 *     0286) exactly, so the two layers never refuse different operations.
 *
 *   flag ON — `super_admin` ALONE. Once D4 narrows `users.manage`, `audit.read`
 *     and `settings.invoicing` to super-admin-only, a plain admin can no longer
 *     administer staff. Counting them would let the last super_admin be erased,
 *     demoted or disabled while only plain admins remain — after which NOBODY
 *     can promote anyone and the tenant is permanently locked out of its own
 *     user administration (SC-003). The application layer is therefore STRICTER
 *     than the DB trigger on this leg, which is safe: the trigger stays the
 *     backstop and never refuses something the app allows.
 *
 * PR 5 (T069) narrows the trigger to super_admin too and deletes the OFF branch.
 */
export const ADMINISTRATIVE_ROLES_LEGACY: readonly Role[] = ['super_admin', 'admin'];
export const ADMINISTRATIVE_ROLES_V2: readonly Role[] = ['super_admin'];

export function administrativeRoles(rbacV2: boolean): readonly Role[] {
  return rbacV2 ? ADMINISTRATIVE_ROLES_V2 : ADMINISTRATIVE_ROLES_LEGACY;
}

export function isAdministrativeRole(
  role: Role | (string & {}),
  rbacV2: boolean,
): boolean {
  return (administrativeRoles(rbacV2) as readonly string[]).includes(role);
}
