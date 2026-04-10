/**
 * change-role use case (T127, spec US4 AS4, FR-010, FR-011).
 *
 * Algorithm:
 *   1. Target lookup — not-found returns 404.
 *   2. Portal-boundary check — staff ↔ member role crossings are
 *      FORBIDDEN in F1 (spec §Q2: separate accounts for staff members
 *      who are also TSCC members). Returns 400 `role-portal-mismatch`.
 *   3. Last-admin protection — if the target is an admin and the new
 *      role would reduce the active-admin count to zero, reject with
 *      `last-admin-protection` (same guarantee as disable-user).
 *   4. Update the role.
 *   5. Kill ALL sessions for the target user so the new role takes
 *      effect cleanly (spec US4 AS4 forces re-authentication).
 *   6. Audit `role_changed` + optional `concurrent_sessions_revoked`.
 */
import { Result, err, ok } from '@/lib/result';
import type { UserId } from '@/modules/auth/domain/branded';
import type { Role } from '@/modules/auth/domain/role';
import type { UserAccount } from '@/modules/auth/domain/user';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultChangeRoleDeps } from '@/lib/auth-deps';

export interface ChangeRoleInput {
  readonly targetUserId: UserId;
  readonly newRole: Role;
  readonly actorUserId: UserId;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface ChangeRoleSuccess {
  readonly user: UserAccount;
  readonly sessionsRevoked: number;
}

export type ChangeRoleError =
  | { readonly code: 'not-found' }
  | { readonly code: 'same-role' }
  | { readonly code: 'role-portal-mismatch' }
  | { readonly code: 'last-admin-protection' };

export interface ChangeRoleDeps {
  readonly users: UserRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
}

export { defaultChangeRoleDeps };

function isStaffRole(role: Role): boolean {
  return role === 'admin' || role === 'manager';
}

export async function changeRole(
  input: ChangeRoleInput,
  deps: ChangeRoleDeps = defaultChangeRoleDeps,
): Promise<Result<ChangeRoleSuccess, ChangeRoleError>> {
  const target = await deps.users.findById(input.targetUserId);
  if (!target) return err({ code: 'not-found' });

  if (target.role === input.newRole) {
    return err({ code: 'same-role' });
  }

  // Portal boundary — staff ↔ member crossings forbidden in F1
  if (isStaffRole(target.role) !== isStaffRole(input.newRole)) {
    return err({ code: 'role-portal-mismatch' });
  }

  // Last-admin protection (only fires when demoting the last admin)
  if (target.role === 'admin' && target.status === 'active' && input.newRole !== 'admin') {
    const activeAdmins = await deps.users.countActiveAdmins();
    if (activeAdmins <= 1) {
      return err({ code: 'last-admin-protection' });
    }
  }

  const previousRole = target.role;
  await deps.users.setRole(target.id, input.newRole);
  const sessionsRevoked = await deps.sessions.deleteByUserId(target.id);

  await deps.audit.append({
    eventType: 'role_changed',
    actorUserId: input.actorUserId,
    targetUserId: target.id,
    sourceIp: input.sourceIp,
    summary: `role changed ${previousRole} → ${input.newRole}`,
    requestId: input.requestId,
  });
  if (sessionsRevoked > 0) {
    await deps.audit.append({
      eventType: 'concurrent_sessions_revoked',
      actorUserId: input.actorUserId,
      targetUserId: target.id,
      sourceIp: input.sourceIp,
      summary: `${sessionsRevoked} session(s) revoked on role change`,
      requestId: input.requestId,
    });
  }

  // Read-after-write: must exist (we just UPDATE'd it). If it
  // doesn't, something is seriously wrong — don't silently return
  // the pre-update row (that would claim the new role took effect
  // while actually returning the old role, breaking the contract).
  const updated = await deps.users.findById(target.id);
  if (!updated) {
    return err({ code: 'not-found' });
  }
  return ok({ user: updated, sessionsRevoked });
}
