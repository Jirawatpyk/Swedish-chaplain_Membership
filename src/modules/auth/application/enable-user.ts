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

/**
 * Reserved UUID range for non-human system actors seeded by migration
 * 0041+ (e.g. `00000000-0000-0000-0000-0000000f5001` Stripe-webhook).
 * Admin endpoints must treat these as not-found so (a) the existence of
 * system rows is not enumerable via 404-vs-403 timing and (b) a flip to
 * `status=active` can't produce misleading `account_reenabled` audit
 * entries. `gen_random_uuid()` never produces this shape (the v4 UUID
 * variant/version bits would collide).
 */
const RESERVED_SYSTEM_ACTOR_PREFIX = '00000000-0000-0000-0000-0000000';

export async function enableUser(
  input: EnableUserInput,
  deps: EnableUserDeps = defaultEnableUserDeps,
): Promise<Result<EnableUserSuccess, EnableUserError>> {
  if (input.targetUserId.startsWith(RESERVED_SYSTEM_ACTOR_PREFIX)) {
    return err({ code: 'not-found' });
  }
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
  // W2-01: a null read-after-write must surface as not-found, NOT fall back to the
  // stale pre-update `target` (which would report success while returning the old
  // `disabled` row). Mirrors the hardened change-role.ts:124-127.
  if (!updated) return err({ code: 'not-found' });
  return ok({ user: updated });
}
