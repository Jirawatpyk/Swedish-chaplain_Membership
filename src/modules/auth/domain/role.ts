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
 * Roles that staff UI may OFFER for assignment/invitation. The 016 staging is
 * COMPLETE: `super_admin` landed in PR 3 (users-page retrofit) and `marketing`
 * in PR 4 (design § 9 / D17), so this now covers every role in ROLES.
 *
 * It is kept as a separate list rather than collapsed into ROLES because it is
 * the single source that the two server zod enums AND the users-page picker must
 * agree with — `assignable-roles-lockstep.test.ts` reads all four and fails
 * loudly on drift. A future role added to ROLES therefore has to make an
 * explicit decision here instead of becoming assignable by default.
 *
 * Order is append-at-end, mirroring the widening history, and is asserted
 * exactly in `role.test.ts` so a reorder shows up as a deliberate diff.
 */
export const ASSIGNABLE_ROLES: readonly Role[] = [
  'admin',
  'manager',
  'member',
  'super_admin',
  'marketing',
];

/**
 * The order roles are PRESENTED in, most-privileged first.
 *
 * `ASSIGNABLE_ROLES` is a SET whose order records the widening history and is
 * pinned exactly by `role.test.ts` — useful for spotting a silent membership
 * change, useless as a UI ordering. Rendering it directly gave the invite dialog
 * "Admin · Manager · Member · Super Admin · Marketing", with the member role
 * wedged into the middle of the staff ones, while the change-role picker on the
 * SAME PAGE listed them by rank. Two pickers, one screen, two orders.
 *
 * Every list rendered to a human orders by this. Membership still comes from
 * `ASSIGNABLE_ROLES` / `CHANGE_ROLE_OPTIONS`; this only sorts.
 */
export const ROLE_DISPLAY_ORDER: readonly Role[] = [
  'super_admin',
  'admin',
  'manager',
  'marketing',
  'member',
];

/** `roles` sorted for display. Anything not in the order list goes last. */
export function byDisplayOrder(roles: readonly Role[]): readonly Role[] {
  const rank = (r: Role): number => {
    const i = ROLE_DISPLAY_ORDER.indexOf(r);
    return i === -1 ? ROLE_DISPLAY_ORDER.length : i;
  };
  return [...roles].sort((a, b) => rank(a) - rank(b));
}

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
 * the last-administrator guard protects. `super_admin` ALONE since PR 5
 * (T069): D4 narrowed `users.manage`, `audit.read` and `settings.invoicing`
 * to super-admin-only at the 2026-08-11 cutover, so a plain admin can no
 * longer administer staff. Counting one would let the last super_admin be
 * erased, demoted or disabled while only capability-less admins remain —
 * after which NOBODY can promote anyone and the tenant is permanently locked
 * out of its own user administration (SC-003).
 *
 * Matches `users_last_admin_guard()` (migration 0288 — the strict rewrite of
 * 0286's transitional union) exactly, so the app pre-flights and the DB
 * trigger never refuse different operations. The flag-parameterised version
 * of this population died with `FEATURE_RBAC_V2` in PR 5.
 */
export const ADMINISTRATIVE_ROLES: readonly Role[] = ['super_admin'];

export function administrativeRoles(): readonly Role[] {
  return ADMINISTRATIVE_ROLES;
}

/** Is this role in the population the last-administrator guard protects? */
export function isAdministrativeRole(role: Role | (string & {})): boolean {
  return (ADMINISTRATIVE_ROLES as readonly string[]).includes(role);
}

