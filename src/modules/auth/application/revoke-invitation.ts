/**
 * revokeInvitation use case — Staff Invitation Lifecycle, Task 3.
 *
 * Admin-triggered destructive op: permanently deletes a `pending` invited
 * user so a typo'd / wrong invite can be removed and the email freed for a
 * fresh invite. `deleteInvitedUser` (the F3 SAGA-compensation use case) is
 * NOT reused here — it requires the original `outboxRowId` captured at
 * `createUser` time, which the admin-facing revoke action does not have.
 *
 * F3-safe by construction: `contacts.linked_user_id` FK is `ON DELETE SET
 * NULL` (migration 0009), so deleting a member-linked pending user cleanly
 * UNLINKS the contact — member data is preserved and the contact reverts to
 * re-invitable. `invitations.user_id` is `ON DELETE CASCADE`, so the token
 * row goes with the user.
 *
 * RA-2 (design review, 2026-07-17) — `notifications_outbox` has NO `user_id`
 * column, so the queued invite email is cleaned up BY EMAIL instead. The
 * email is captured from `deleteInvitedPendingInTx`'s own `RETURNING`
 * (read-before-delete — never re-resolved after the user row is gone) and
 * threaded, together with `tenantId`, into `deleteInviteOutboxByEmailInTx`,
 * which additionally scopes the DELETE to `notification_type='member_invitation'`
 * AND `status='pending'` AND the caller's tenant (RA-3 — Principle I: a
 * revoke in one tenant must never delete another tenant's queued invite for
 * the same email address).
 *
 * Atomicity: the user delete, the outbox cleanup, and the
 * `invitation_revoked` audit all run inside ONE owner-role `db.transaction`
 * (mirrors `reissue-invitation.ts` / `delete-invited-user.ts` — F1 flows are
 * cross-tenant, so `runInTenant` cannot be used). If `deleted === 0` (no
 * pending row matched — already redeemed/active, disabled, or never
 * existed), the tx aborts via the `TxAbort` sentinel BEFORE the outbox
 * cleanup or the audit run — nothing was destroyed, so nothing is recorded.
 * If the outbox delete throws, the thrown error propagates out of the
 * `db.transaction` callback (Drizzle rolls the whole tx back — the user
 * delete never commits either) and back out of this function; unlike
 * `deleteInvitedUser`, `RevokeInvitationError` has no generic-failure
 * variant to collapse an unexpected fault into, so this mirrors
 * `reissueInvitation`'s catch (only `TxAbort` is mapped to a typed `err`;
 * anything else rethrows to the caller).
 */
import { Result, err, ok } from '@/lib/result';
import { db } from '@/lib/db';
import type { UserId } from '@/modules/auth/domain/branded';
import type { TenantSlug } from '@/modules/tenants/domain/tenant-slug';
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { TxAbort } from './tx-abort';
import { defaultRevokeInvitationDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface RevokeInvitationInput {
  readonly userId: UserId;
  readonly actorUserId: UserId;
  readonly tenantId: TenantSlug;
  readonly sourceIp: string;
  readonly requestId: string;
  /** For the audit summary only (never used to find the user). */
  readonly targetEmail?: string | undefined;
}

export interface RevokeInvitationSuccess {
  readonly deleted: true;
}

export type RevokeInvitationError = {
  /** No `pending` row matched `userId` — already redeemed/active, disabled, or absent. */
  readonly code: 'not-pending-or-not-found';
};

// --- Dependencies ------------------------------------------------------------

export interface RevokeInvitationDeps {
  readonly users: Pick<UserRepo, 'deleteInvitedPendingInTx' | 'deleteInviteOutboxByEmailInTx'>;
  readonly audit: Pick<AuditRepo, 'appendInTx'>;
}

export { defaultRevokeInvitationDeps };

// --- Use case ----------------------------------------------------------------

export async function revokeInvitation(
  input: RevokeInvitationInput,
  deps: RevokeInvitationDeps = defaultRevokeInvitationDeps,
): Promise<Result<RevokeInvitationSuccess, RevokeInvitationError>> {
  try {
    await db.transaction(async (tx) => {
      // 1. Delete-with-guard: only a `status='pending'` row is removed —
      //    a redeemed/active account is NEVER destroyed. RETURNING captures
      //    the email in the SAME statement (read-before-delete).
      const { deleted, email } = await deps.users.deleteInvitedPendingInTx(tx, input.userId);
      if (deleted === 0) {
        throw new TxAbort<RevokeInvitationError>({ code: 'not-pending-or-not-found' });
      }

      // 2. Drop the queued invite email so it can never dispatch for the
      //    now-deleted user. `email` is guaranteed non-null here — the same
      //    RETURNING that produced `deleted > 0` read this row's `email`
      //    column, which is NOT NULL in the schema.
      await deps.users.deleteInviteOutboxByEmailInTx(tx, email as string, input.tenantId);

      // 3. Record the revoke.
      await deps.audit.appendInTx(tx, {
        eventType: 'invitation_revoked',
        actorUserId: input.actorUserId,
        targetUserId: input.userId,
        sourceIp: input.sourceIp,
        requestId: input.requestId,
        summary: `invitation revoked for ${input.targetEmail ?? email ?? input.userId}`,
      });
    });
    return ok({ deleted: true });
  } catch (e) {
    if (e instanceof TxAbort) {
      return err(e.error as RevokeInvitationError);
    }
    throw e;
  }
}
