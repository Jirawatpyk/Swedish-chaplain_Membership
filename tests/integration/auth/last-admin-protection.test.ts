/**
 * T-10 last-admin-protection dedicated test (security.md § 3 row T-10,
 * spec FR-011, SC-009).
 *
 * Why this lives separately from `role-change-race.test.ts`:
 *
 * The race test asserts the INVARIANT (at least one admin always
 * survives) but cannot cleanly prove the GUARD fires in the exact
 * "only one admin left" branch — CI baselines always have ≥ 3 admins
 * (bootstrap + seeded test users), so the guard path is never
 * actually entered. That gap was called out in the verify gate:
 * "the test passes even if the guard were deleted".
 *
 * This test closes the gap by injecting a counting UserRepo that
 * reports exactly ONE active admin, regardless of the real DB state.
 * The guard logic (`countActiveAdmins() <= 1`) then fires
 * deterministically on both `disableUser` and `changeRole`, and we
 * assert the specific `last-admin-protection` error code is
 * returned.
 *
 * We inject the mock via the use case's `deps` parameter. The
 * approach is non-destructive: the real bootstrap admin is never
 * touched, and no rows are mutated during the guard path (both
 * use cases short-circuit before any UPDATE).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableUser } from '@/modules/auth/application/disable-user';
import { changeRole } from '@/modules/auth/application/change-role';
import {
  userRepo,
  type UserRepo,
} from '@/modules/auth/infrastructure/db/user-repo';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { auditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

/**
 * Wrap the real `userRepo` so every method delegates except
 * `countActiveAdmins()`, which returns a hardcoded `1`. This is the
 * minimum stub needed to force the guard branch on deterministically.
 *
 * The guard in both `disableUser` and `changeRole` short-circuits
 * BEFORE any mutating call (`disable`, `setRole`), so the overridden
 * count is the only lever we need.
 */
function oneAdminRepo(): UserRepo {
  return {
    findByEmail: (email) => userRepo.findByEmail(email),
    findByEmailInTx: (tx, email) => userRepo.findByEmailInTx(tx, email),
    findById: (id) => userRepo.findById(id),
    findByIdInTx: (tx, id) => userRepo.findByIdInTx(tx, id),
    updateLastSignIn: (id, at) => userRepo.updateLastSignIn(id, at),
    incrementFailedCount: (id) => userRepo.incrementFailedCount(id),
    clearFailedCount: (id) => userRepo.clearFailedCount(id),
    setLocked: (id, until) => userRepo.setLocked(id, until),
    clearLock: (id) => userRepo.clearLock(id),
    // THE POINT of this wrapper: pretend there is only one admin.
    countActiveAdmins: async () => 1,
    createPending: (args) => userRepo.createPending(args),
    createPendingInTx: (tx, args) => userRepo.createPendingInTx(tx, args),
    deletePending: (id) => userRepo.deletePending(id),
    deleteInvitedPendingInTx: (tx, id) => userRepo.deleteInvitedPendingInTx(tx, id),
    deleteInviteOutboxByEmailInTx: (tx, email, tenantId) =>
      userRepo.deleteInviteOutboxByEmailInTx(tx, email, tenantId),
    deletePendingInvitesExpiredBeforeInTx: (tx, cutoff) =>
      userRepo.deletePendingInvitesExpiredBeforeInTx(tx, cutoff),
    deleteInviteOutboxByEmailAllTenantsInTx: (tx, email) =>
      userRepo.deleteInviteOutboxByEmailAllTenantsInTx(tx, email),
    anonymiseErasedInTx: (tx, userId) => userRepo.anonymiseErasedInTx(tx, userId),
    setPasswordHash: (id, hash, now) =>
      userRepo.setPasswordHash(id, hash, now),
    setPasswordHashInTx: (tx, id, hash, now) =>
      userRepo.setPasswordHashInTx(tx, id, hash, now),
    activate: (id, now) => userRepo.activate(id, now),
    activateInTx: (tx, id, now) => userRepo.activateInTx(tx, id, now),
    setDisplayNameInTx: (tx, id, displayName) =>
      userRepo.setDisplayNameInTx(tx, id, displayName),
    clearLockAndFailedCountInTx: (tx, id) =>
      userRepo.clearLockAndFailedCountInTx(tx, id),
    disable: (id) => userRepo.disable(id),
    enable: (id) => userRepo.enable(id),
    setRole: (id, role) => userRepo.setRole(id, role),
    list: (limit, offset) => userRepo.list(limit, offset),
    countAll: () => userRepo.countAll(),
    listWithFilter: (filter, limit, offset) =>
      userRepo.listWithFilter(filter, limit, offset),
    countWithFilter: (filter) => userRepo.countWithFilter(filter),
  };
}

describe('integration: last-admin-protection guard (T-10)', () => {
  let target: TestUser;

  beforeEach(async () => {
    target = await createActiveTestUser('admin');
  });

  afterEach(async () => {
    await deleteTestUser(target);
  });

  it('disableUser refuses when exactly one admin remains', async () => {
    // Pass a deps object that claims only one admin exists. The guard
    // short-circuits BEFORE any row is updated, so this is a pure
    // read-only probe of the guard branch.
    const result = await disableUser(
      {
        targetUserId: target.userId,
        actorUserId: target.userId,
        sourceIp: '203.0.113.80',
        requestId: `it-last-admin-disable-${Date.now()}`,
      },
      {
        users: oneAdminRepo(),
        sessions: sessionRepo,
        audit: auditRepo,
        now: () => new Date(),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('last-admin-protection');
  });

  it('changeRole refuses to demote the last admin', async () => {
    const result = await changeRole(
      {
        targetUserId: target.userId,
        newRole: 'manager',
        actorUserId: target.userId,
        sourceIp: '203.0.113.81',
        requestId: `it-last-admin-demote-${Date.now()}`,
      },
      {
        users: oneAdminRepo(),
        sessions: sessionRepo,
        audit: auditRepo,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('last-admin-protection');
  });

  it('changeRole ALLOWS promoting a non-admin even when only one admin remains', async () => {
    // Sanity: the last-admin guard is specific to DEMOTING or
    // DISABLING the last admin. Promoting a manager to admin is
    // explicitly allowed — it grows the admin count, it doesn't
    // shrink it — so the guard MUST skip the check even when
    // `countActiveAdmins()` returns 1.
    //
    // We use manager → admin (both staff-portal roles) because:
    //   - Target role is NOT admin → guard is never entered
    //     (the guard fires only when `target.role === 'admin'`)
    //   - Both are staff roles → no portal-mismatch rejection
    //   - The promotion is semantically valid under the policy
    const managerTarget = await createActiveTestUser('manager');
    try {
      const result = await changeRole(
        {
          targetUserId: managerTarget.userId,
          newRole: 'admin',
          actorUserId: target.userId, // any admin will do
          sourceIp: '203.0.113.82',
          requestId: `it-last-admin-promote-${Date.now()}`,
        },
        {
          users: oneAdminRepo(),
          sessions: sessionRepo,
          audit: auditRepo,
        },
      );
      expect(result.ok).toBe(true);
    } finally {
      // Demote + delete. Demote first because deleteTestUser
      // doesn't override the role and the cleanup helper might
      // trip the bootstrap admin count guard on a real clean-up
      // path in the future.
      await deleteTestUser(managerTarget);
    }
  });
});
