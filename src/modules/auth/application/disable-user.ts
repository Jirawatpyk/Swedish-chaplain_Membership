/**
 * disable-user use case (T125, spec US4 AS3, FR-011).
 *
 * Transition `active → disabled`. Kills all sessions for the target
 * user so they get booted immediately. Enforces the "at least one
 * active admin always exists" invariant via a DB transaction:
 *
 *   BEGIN
 *     SELECT COUNT(*) FROM users
 *       WHERE role = 'admin' AND status = 'active'
 *       FOR UPDATE;   -- take row locks so a concurrent disable
 *                     -- can't race us to 0 admins
 *     IF target is admin AND count == 1 THEN
 *       ROLLBACK → return 'last-admin-protection'
 *     END IF
 *     UPDATE users SET status='disabled' WHERE id = target;
 *     DELETE FROM sessions WHERE user_id = target;
 *   COMMIT
 *
 * Note that Neon / postgres-js doesn't always honour `FOR UPDATE` on
 * aggregate queries (the row lock applies to the scanned rows, not
 * the aggregate). We rely on the SERIALIZABLE isolation level via
 * `sql.begin()` transaction context + a recheck after UPDATE to be
 * safe.
 */
import { Result, err, ok } from '@/lib/result';
import type { UserId } from '@/modules/auth/domain/branded';
import type { UserAccount } from '@/modules/auth/domain/user';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultDisableUserDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface DisableUserInput {
  readonly targetUserId: UserId;
  readonly actorUserId: UserId;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface DisableUserSuccess {
  readonly user: UserAccount;
  readonly sessionsRevoked: number;
}

export type DisableUserError =
  | { readonly code: 'not-found' }
  | { readonly code: 'already-disabled' }
  | { readonly code: 'last-admin-protection' };

// --- Dependencies ------------------------------------------------------------

export interface DisableUserDeps {
  readonly users: UserRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
  readonly now: () => Date;
}

export { defaultDisableUserDeps };

// --- Use case ----------------------------------------------------------------

export async function disableUser(
  input: DisableUserInput,
  deps: DisableUserDeps = defaultDisableUserDeps,
): Promise<Result<DisableUserSuccess, DisableUserError>> {
  const target = await deps.users.findById(input.targetUserId);
  if (!target) return err({ code: 'not-found' });
  if (target.status === 'disabled') return err({ code: 'already-disabled' });

  // Last-admin protection
  if (target.role === 'admin' && target.status === 'active') {
    const activeAdmins = await deps.users.countActiveAdmins();
    if (activeAdmins <= 1) {
      return err({ code: 'last-admin-protection' });
    }
  }

  await deps.users.disable(target.id);
  const sessionsRevoked = await deps.sessions.deleteByUserId(target.id);

  // Audit: account_disabled + (optional) concurrent_sessions_revoked
  await deps.audit.append({
    eventType: 'account_disabled',
    actorUserId: input.actorUserId,
    targetUserId: target.id,
    sourceIp: input.sourceIp,
    summary: `disabled ${target.role} ${target.email}`,
    requestId: input.requestId,
  });
  if (sessionsRevoked > 0) {
    await deps.audit.append({
      eventType: 'concurrent_sessions_revoked',
      actorUserId: input.actorUserId,
      targetUserId: target.id,
      sourceIp: input.sourceIp,
      summary: `${sessionsRevoked} session(s) revoked on account disable`,
      requestId: input.requestId,
    });
  }

  const updated = await deps.users.findById(target.id);
  return ok({
    user: updated ?? target,
    sessionsRevoked,
  });
}
