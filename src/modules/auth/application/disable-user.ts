/**
 * disable-user use case (T125, spec US4 AS3, FR-011).
 *
 * Transition `active → disabled`. Kills all sessions for the target
 * user so they get booted immediately. Enforces the "at least one
 * active admin always exists" invariant in two layers:
 *
 *   Layer 1 (Application — race-prone, fast happy-path):
 *     pre-tx `countActiveAdmins()` short-circuits at value == 1 when
 *     the target is the active admin → returns `last-admin-protection`
 *     without opening a tx.
 *
 *   Layer 2 (DB — race-safe, authoritative):
 *     trigger `users_last_admin_protection` (migrations 0003 + 0004)
 *     raises `SQLSTATE 23514 last-admin-protection` if a concurrent
 *     UPDATE/DELETE would drop the active-admin count below 1. The
 *     trigger is the source of truth; the Application check is a UX
 *     optimisation only.
 *
 * The catch at the bottom of `disableUserImpl` maps trigger throws
 * via `isLastAdminTriggerError` into the same `last-admin-protection`
 * Result so the caller never distinguishes layer 1 vs layer 2.
 *
 * Pre-W-02 (PR #1 staff-review) this used a hand-rolled SERIALIZABLE
 * tx with FOR UPDATE; that comment block survives in git history at
 * commit 905137f1 if a future maintainer wonders why we replaced it.
 */
import { Result, err, ok } from '@/lib/result';
import { isLastAdminTriggerError } from '@/lib/db-errors';
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

  // Last-admin protection — first line of defence (application layer).
  // The DB trigger `users_last_admin_protection` (migration 0003) is
  // the second line of defence and closes the race window between
  // `countActiveAdmins()` and `disable()`.
  if (target.role === 'admin' && target.status === 'active') {
    const activeAdmins = await deps.users.countActiveAdmins();
    if (activeAdmins <= 1) {
      return err({ code: 'last-admin-protection' });
    }
  }

  try {
    await deps.users.disable(target.id);
  } catch (error) {
    // The DB trigger raises SQLSTATE 23514 (check_violation) when a
    // concurrent request races us to zero active admins. Translate
    // it to the existing public error code so callers see a
    // consistent shape.
    if (isLastAdminTriggerError(error)) {
      return err({ code: 'last-admin-protection' });
    }
    throw error;
  }
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
  // W2-01: a null read-after-write must surface as not-found, NOT fall back to the
  // stale pre-update `target` (which would report the old `active` row). Mirrors change-role.
  if (!updated) return err({ code: 'not-found' });
  return ok({
    user: updated,
    sessionsRevoked,
  });
}
