/**
 * Role enum and portal mapping (data-model.md § 2.1, spec Q4).
 *
 * Three roles exactly: admin, manager, member. They are NEVER combined.
 * Pure TypeScript — Domain layer; no framework imports.
 */

export const ROLES = ['admin', 'manager', 'member'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that sign in via /admin (the staff portal). */
export const STAFF_ROLES: readonly Role[] = ['admin', 'manager'];

/**
 * Which portal a given role lands on after sign-in.
 *
 * - admin / manager → 'staff' (`/admin/**`)
 * - member          → 'member' (`/portal/**`)
 *
 * Cross-portal sign-in is rejected with the same generic
 * `invalid-credentials` message used for wrong passwords (spec FR-016)
 * so the response doesn't leak which portal an account belongs to.
 */
export const PORTAL_FOR_ROLE: Record<Role, 'staff' | 'member'> = {
  admin: 'staff',
  manager: 'staff',
  member: 'member',
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isStaffRole(role: Role): boolean {
  return STAFF_ROLES.includes(role);
}
