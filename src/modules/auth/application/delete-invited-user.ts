/**
 * delete-invited-user use case (go-live /code-review #12-13).
 *
 * SAGA compensation for the F3 `invitePortal` orphan window: F1 `createUser`
 * commits a pending user + invitation + queued invite email in its own
 * owner-role tx; the contact link then runs in a SEPARATE chamber_app tx
 * (the role split — chamber_app cannot INSERT invitations — forbids one atomic
 * tx). If the link step fails AFTER createUser committed, `invitePortal` calls
 * THIS use case to ROLL BACK the just-created invite, so no orphan persists
 * (the pre-existing code falsely claimed redemption self-heals — it does not;
 * redeem-invite never touches contacts.linked_user_id).
 *
 * Runs in ONE owner-role `db.transaction` (BYPASSRLS), mirroring create-user:
 *   1. delete the pending user by EXACT id, guarded by `status='pending'`
 *      (`deleteInvitedPendingInTx`). The invitation row FK-cascades from the
 *      user. SECURITY: id-only + pending-guard — no email lookup, no tenant
 *      scope to get wrong, so a redeemed/active account is NEVER destroyed and
 *      no contact can ever be linked to the wrong user.
 *   2. if 0 rows were deleted (the user already redeemed/activated between
 *      createUser and this compensation — a benign race) → no-op, return
 *      `compensated: false`, touch nothing else.
 *   3. otherwise delete the queued `notifications_outbox` invite row by id so
 *      no dead invite email is dispatched for the now-deleted user.
 *   4. append `account_creation_compensated` (the append-only `account_created`
 *      row stays — Principle VIII — this records the undo).
 *
 * Never throws out: an unexpected fault returns `err({code:'compensation-failed'})`
 * so the caller can still surface a typed result (the orphan persists in that
 * rare-of-rare case, but `account_created` + this error log are the trail).
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { db, type DbTx } from '@/lib/db';
import type { UserId } from '@/modules/auth/domain/branded';
import type { ActorRef } from '@/modules/auth/domain/audit-event';
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultDeleteInvitedUserDeps } from '@/lib/auth-deps';

export interface DeleteInvitedUserInput {
  readonly userId: UserId;
  /** The `notifications_outbox` row id from `CreateUserSuccess` to delete. */
  readonly outboxRowId: string;
  readonly actorUserId: string;
  readonly sourceIp: string;
  readonly requestId: string;
  /** For the audit summary only (never used to find the user). */
  readonly targetEmail?: string | undefined;
}

export interface DeleteInvitedUserSuccess {
  /**
   * `true`  — the pending user (+ FK-cascaded invitation + queued email) was
   *           rolled back.
   * `false` — a no-op: the user was already redeemed/active (race), so nothing
   *           was destroyed.
   */
  readonly compensated: boolean;
}

export type DeleteInvitedUserError = {
  readonly code: 'compensation-failed';
  readonly cause?: unknown;
};

export interface DeleteInvitedUserDeps {
  readonly users: Pick<UserRepo, 'deleteInvitedPendingInTx'>;
  readonly deleteOutboxInTx: (tx: DbTx, outboxRowId: string) => Promise<void>;
  readonly audit: Pick<AuditRepo, 'appendInTx'>;
}

export { defaultDeleteInvitedUserDeps };

export async function deleteInvitedUser(
  input: DeleteInvitedUserInput,
  deps: DeleteInvitedUserDeps = defaultDeleteInvitedUserDeps,
): Promise<Result<DeleteInvitedUserSuccess, DeleteInvitedUserError>> {
  try {
    const outcome = await db.transaction(async (tx) => {
      const { deleted } = await deps.users.deleteInvitedPendingInTx(tx, input.userId);
      if (deleted === 0) {
        // Race: the user redeemed/activated between createUser and this
        // compensation. Never destroy a live account — no-op.
        return { compensated: false };
      }
      // Drop the queued invite email so no dead invite is dispatched.
      await deps.deleteOutboxInTx(tx, input.outboxRowId);
      // Record the undo (account_created stays; append-only Principle VIII).
      await deps.audit.appendInTx(tx, {
        eventType: 'account_creation_compensated',
        // The route passes the raw session user id; treat it as the actor (same
        // boundary convention as createUserPort's actorUserId cast).
        actorUserId: input.actorUserId as ActorRef,
        targetUserId: input.userId,
        sourceIp: input.sourceIp,
        summary: `rolled back orphaned portal invite for ${input.targetEmail ?? input.userId}`,
        requestId: input.requestId,
      });
      return { compensated: true };
    });
    return ok(outcome);
  } catch (e) {
    logger.error(
      {
        requestId: input.requestId,
        errMessage: e instanceof Error ? e.message : String(e),
      },
      'delete_invited_user.compensation_failed',
    );
    return err({ code: 'compensation-failed', cause: e });
  }
}
