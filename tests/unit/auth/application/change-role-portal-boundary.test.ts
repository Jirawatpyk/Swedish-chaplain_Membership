/**
 * Unit: `changeRole` portal-boundary invariant over ALL five roles
 * (016-rbac-permissions; review 016 PR1 rbac-4 / sec-1 / arch-1).
 *
 * The use case used to carry a private `isStaffRole` copy that 016's ROLES
 * widening silently made stale — it classified `super_admin` and `marketing`
 * as member-side, so a staff↔member crossing would have been ALLOWED for the
 * exact roles the feature introduces (a portal-boundary fail-open with no
 * compile-time signal, because the parameter type is `Role`). The use case now
 * delegates to the Domain `isStaffRole`; these cases are the tripwire that
 * fails loudly if a future role lands on the wrong side of the boundary.
 */

import { describe, expect, it, vi } from 'vitest';

import { changeRole, type ChangeRoleDeps } from '@/modules/auth/application/change-role';
import { asUserId } from '@/modules/auth/domain/branded';
import { ROLES, STAFF_ROLES, type Role } from '@/modules/auth/domain/role';
import type { UserAccount } from '@/modules/auth/domain/user';

const TARGET_ID = asUserId('11111111-1111-4111-8111-111111111111');
const ACTOR_ID = asUserId('22222222-2222-4222-8222-222222222222');

function targetUser(role: Role): UserAccount {
  return {
    id: TARGET_ID,
    email: 'target@example.test',
    role,
    status: 'active',
    displayName: 'Target',
  } as UserAccount;
}

/** Deps that always succeed — the assertions are about the refusal branch. */
function makeDeps(role: Role): ChangeRoleDeps {
  return {
    users: {
      findById: vi.fn().mockResolvedValue(targetUser(role)),
      // High enough that last-admin protection never fires in these cases.
      countActiveAdmins: vi.fn().mockResolvedValue(5),
      setRole: vi.fn().mockResolvedValue(undefined),
    },
    sessions: { deleteByUserId: vi.fn().mockResolvedValue(0) },
    audit: { append: vi.fn().mockResolvedValue(undefined) },
  } as unknown as ChangeRoleDeps;
}

async function attempt(from: Role, to: Role) {
  return changeRole(
    {
      targetUserId: TARGET_ID,
      newRole: to,
      actorUserId: ACTOR_ID,
      sourceIp: '203.0.113.7',
      requestId: 'req-portal-boundary',
    },
    makeDeps(from),
  );
}

const STAFF = ROLES.filter((r) => STAFF_ROLES.includes(r));

describe('changeRole — staff↔member portal boundary (all five roles)', () => {
  it.each(STAFF.map((r) => [r] as const))('refuses %s → member', async (from) => {
    const result = await attempt(from, 'member');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('role-portal-mismatch');
  });

  it.each(STAFF.map((r) => [r] as const))('refuses member → %s', async (to) => {
    const result = await attempt('member', to);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('role-portal-mismatch');
  });

  it.each(
    STAFF.flatMap((from) => STAFF.filter((to) => to !== from).map((to) => [from, to] as const)),
  )('permits staff→staff %s → %s', async (from, to) => {
    const result = await attempt(from, to);
    // Staff↔staff is legal. Note which direction depends on THIS use case:
    // Migration C's promotion is a raw `UPDATE users SET role='super_admin'`
    // inside the runner's batch transaction (design § 5), so it does not pass
    // through changeRole — but the account-level rollback (demotion back to
    // admin) does, and so will every UI role change from PR 3 onward.
    expect(result.ok).toBe(true);
  });
});
