/**
 * enable-user use case (T126, spec US4 AS3).
 *
 * Transition `disabled → active`. Clears failed count and lockout as
 * part of the re-enable so the returning user can sign in immediately.
 * Emits `account_reenabled` audit event.
 */
import { Result, err, ok } from '@/lib/result';
import type { UserId } from '@/modules/auth/domain/branded';
import type { UserAccount } from '@/modules/auth/domain/user';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultEnableUserDeps } from '@/lib/auth-deps';

export interface EnableUserInput {
  readonly targetUserId: UserId;
  readonly actorUserId: UserId;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface EnableUserSuccess {
  readonly user: UserAccount;
}

export type EnableUserError =
  | { readonly code: 'not-found' }
  | { readonly code: 'not-disabled' };

export interface EnableUserDeps {
  readonly users: UserRepo;
  readonly audit: AuditRepo;
}

export { defaultEnableUserDeps };

export async function enableUser(
  input: EnableUserInput,
  deps: EnableUserDeps = defaultEnableUserDeps,
): Promise<Result<EnableUserSuccess, EnableUserError>> {
  const target = await deps.users.findById(input.targetUserId);
  if (!target) return err({ code: 'not-found' });
  if (target.status !== 'disabled') return err({ code: 'not-disabled' });

  await deps.users.enable(target.id);

  await deps.audit.append({
    eventType: 'account_reenabled',
    actorUserId: input.actorUserId,
    targetUserId: target.id,
    sourceIp: input.sourceIp,
    summary: `re-enabled ${target.role} ${target.email}`,
    requestId: input.requestId,
  });

  const updated = await deps.users.findById(target.id);
  return ok({ user: updated ?? target });
}
