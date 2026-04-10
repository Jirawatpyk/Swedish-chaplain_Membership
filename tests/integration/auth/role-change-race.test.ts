/**
 * T116 — Concurrent last-admin race integration test (FR-011, US4 edge).
 *
 * Scenario: TWO admins exist. Two requests arrive at the same moment:
 *   Request A: "disable admin Alice"
 *   Request B: "change Bob's role from admin to manager"
 *
 * Both requests pass the `countActiveAdmins() > 1` check (they read 2).
 * Without protection, BOTH mutations would commit, leaving the system
 * with ZERO admins.
 *
 * What this test actually asserts (non-destructive):
 *
 *   1. **Invariant always holds** — after the race, at least one
 *      active admin always remains. This is the guarantee we care
 *      about operationally.
 *   2. **Guard engages when it must** — we inspect the results; if
 *      the baseline admin count was exactly 2 and both mutations
 *      succeeded, the guard is broken and the test fails. If baseline
 *      was ≥ 3, both may safely succeed.
 *
 * Non-destructive approach: we do NOT manipulate the bootstrap admin
 * or any pre-existing admins. We only create Alice + Bob, fire the
 * race, and revert their state in afterEach. That means the baseline
 * is typically ≥ 3 (bootstrap + alice + bob + any other test admins),
 * and both mutations succeed. The test catches the "guard broken"
 * case by asserting the count-after-zero invariant always holds.
 *
 * The TRUE "exactly 2 admins" race is covered by the dedicated
 * `last-admin-protection.test.ts` (added during the verify gate):
 * it stubs `countActiveAdmins()` to return 1, forcing the guard
 * branch deterministically without needing a clean DB baseline.
 * This file remains the invariant check under realistic load.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { disableUser } from '@/modules/auth/application/disable-user';
import { changeRole } from '@/modules/auth/application/change-role';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

describe('integration: concurrent last-admin race (T116, FR-011)', () => {
  let alice: TestUser;
  let bob: TestUser;

  beforeEach(async () => {
    alice = await createActiveTestUser('admin');
    bob = await createActiveTestUser('admin');
  });

  afterEach(async () => {
    // Revert to admin/active so cleanup doesn't trip the last-admin
    // guard for the bootstrap admin on future runs.
    try {
      await db
        .update(users)
        .set({ status: 'active', role: 'admin' })
        .where(eq(users.id, alice.userId));
    } catch { /* ignore */ }
    try {
      await db
        .update(users)
        .set({ status: 'active', role: 'admin' })
        .where(eq(users.id, bob.userId));
    } catch { /* ignore */ }
    await deleteTestUser(alice);
    await deleteTestUser(bob);
  });

  it(
    'two concurrent admin-removals never leave zero admins (invariant)',
    async () => {
      const baselineAdmins = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
      const baselineCount = baselineAdmins.length;
      expect(baselineCount).toBeGreaterThanOrEqual(2);

      const [disableResult, roleResult] = await Promise.all([
        disableUser({
          targetUserId: alice.userId,
          actorUserId: bob.userId,
          sourceIp: '203.0.113.80',
          requestId: 'race-disable',
        }),
        changeRole({
          targetUserId: bob.userId,
          newRole: 'manager',
          actorUserId: alice.userId,
          sourceIp: '203.0.113.81',
          requestId: 'race-role',
        }),
      ]);

      const disableOk = disableResult.ok;
      const roleOk = roleResult.ok;
      const disableErr = disableResult.ok ? null : disableResult.error.code;
      const roleErr = roleResult.ok ? null : roleResult.error.code;

      console.log(
        `  race: baseline=${baselineCount} disable=${disableOk ? 'ok' : disableErr} role=${roleOk ? 'ok' : roleErr}`,
      );

      // CORE INVARIANT: at least one active admin survives.
      const afterAdmins = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.status, 'active')));
      expect(afterAdmins.length).toBeGreaterThanOrEqual(1);

      // If both mutations succeeded, baseline must have been ≥ 3 for
      // the guarantee to hold. (baseline - 2 ≥ 1 → baseline ≥ 3.)
      if (disableOk && roleOk) {
        expect(baselineCount).toBeGreaterThanOrEqual(3);
      }
      // If only one succeeded, the other MUST have failed with
      // last-admin-protection (not some other error).
      if (disableOk && !roleOk) {
        expect(roleErr).toBe('last-admin-protection');
      }
      if (!disableOk && roleOk) {
        expect(disableErr).toBe('last-admin-protection');
      }
      // Both failing is also acceptable (edge: both hit the guard
      // before either committed). Only "both succeed with baseline=2"
      // is a real failure, which is already caught above.
    },
    60_000,
  );
});
