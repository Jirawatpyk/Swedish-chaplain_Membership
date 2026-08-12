/**
 * Contract: `ASSIGNABLE_ROLES` ↔ the server-side role zod enums must stay in
 * lockstep (016-rbac-permissions; review 016 PR1 conv-1 / type-7 / test-3).
 *
 * `ASSIGNABLE_ROLES` restricts what the invite dialog OFFERS. The authoritative
 * gate is the server: `POST /api/auth/invite` and `POST /api/auth/users/[id]/role`
 * each carry a zod enum. A UI-only restriction with a permissive API would be a
 * privilege-escalation path, and a widened UI with a stale API is a dead option.
 * PR 3 (super_admin) and PR 4 (marketing) widen all three together — this test
 * fails loudly if one moves without the others.
 *
 * The schemas are re-declared here rather than exported from the route modules:
 * importing a route pulls the whole Next.js server graph into the unit runner.
 * The literal is kept in sync by the source-text assertions below, which read
 * the real route files.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ASSIGNABLE_ROLES, isStaffRole, ROLES } from '@/modules/auth/domain/role';
import { CHANGE_ROLE_OPTIONS } from '@/components/auth/change-role-dialog';

const ROUTES = [
  { label: 'invite', path: join('src', 'app', 'api', 'auth', 'invite', 'route.ts') },
  {
    label: 'change-role',
    path: join('src', 'app', 'api', 'auth', 'users', '[id]', 'role', 'route.ts'),
  },
];

/** Extracts the string literals of the first `z.enum([...])` in a source file. */
function firstZodEnumValues(source: string): string[] {
  const match = source.match(/z\.enum\(\[([^\]]*)\]\)/);
  if (!match?.[1]) throw new Error('no z.enum([...]) found');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('ASSIGNABLE_ROLES ↔ server role enums (lockstep)', () => {
  it.each(ROUTES)('$label route accepts exactly ASSIGNABLE_ROLES', ({ path }) => {
    const values = firstZodEnumValues(readFileSync(join(process.cwd(), path), 'utf8'));
    expect([...values].sort()).toEqual([...ASSIGNABLE_ROLES].sort());
  });

  it.each(ROUTES)('$label route rejects every not-yet-assignable role', ({ path }) => {
    const values = firstZodEnumValues(readFileSync(join(process.cwd(), path), 'utf8'));
    const schema = z.enum(values as [string, ...string[]]);
    const notAssignable = ROLES.filter((r) => !ASSIGNABLE_ROLES.includes(r));

    // PR 4 closed the staging window — every role is assignable now, so this set
    // is empty and the loop below is vacuous. Kept deliberately: it is the guard
    // that catches a FUTURE role added to ROLES without a decision about whether
    // it may be assigned. When that happens this test starts doing work again.
    expect(notAssignable).toEqual([]);
    for (const role of notAssignable) {
      expect(schema.safeParse(role).success, `${role} must be rejected`).toBe(false);
    }
  });

  /**
   * The THIRD list, which this file did not cover until PR 4.
   *
   * `CHANGE_ROLE_OPTIONS` (change-role-dialog.tsx) is what the users-page picker
   * actually renders. It sat outside the lockstep, so a role could become
   * assignable at the API while remaining unofferable in the UI — or worse, the
   * reverse. It is deliberately NOT equal to ASSIGNABLE_ROLES: `member` is
   * excluded because moving someone between the staff and member portals is a
   * different operation from re-ranking a staff member, and the route rejects it
   * with `role-portal-mismatch` anyway.
   *
   * The invariant is therefore `ASSIGNABLE_ROLES ∩ STAFF_ROLES`, which stays
   * correct automatically as roles are added.
   */
  it('CHANGE_ROLE_OPTIONS is exactly the assignable STAFF roles', () => {
    const expected = ASSIGNABLE_ROLES.filter((r) => isStaffRole(r));
    expect([...CHANGE_ROLE_OPTIONS].sort()).toEqual([...expected].sort());
    expect(CHANGE_ROLE_OPTIONS, 'member is a portal move, not a staff re-rank').not.toContain(
      'member',
    );
    expect(CHANGE_ROLE_OPTIONS).toContain('marketing');
  });
});
