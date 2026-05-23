/**
 * reissue-invitation use case — F1 primitive backing F3
 * `resend-bounced-invite` (spec F3 § Edge Cases).
 *
 * Mints a FRESH invitation token + outbox email for an EXISTING pending
 * user whose previous invitation email bounced. Symmetric to
 * `create-user` but it does NOT create a user — the `pending` user row
 * already exists (created by `invitePortal` → `createUser` at first
 * invite). Both side effects (invitation insert + outbox enqueue)
 * execute inside a SINGLE owner-role `db.transaction(...)`:
 *
 *   BEGIN;
 *     SELECT ... FROM users WHERE id = $1 FOR ...   -- lock + verify pending
 *     INSERT INTO invitations (...);
 *     INSERT INTO notifications_outbox (...);
 *   COMMIT;
 *
 * Why `db.transaction` (owner role) and NOT `runInTenant` (chamber_app):
 *   The `invitations` table is the F1 account-provisioning surface.
 *   `chamber_app` deliberately has NO INSERT grant on it (migrations
 *   0016/0017 — least privilege; a chamber_app SQLi must not be able to
 *   FORGE an invitation row binding an attacker-chosen plaintext to a
 *   chosen user_id+role and then redeem it to set that account's
 *   password). The owner role used by `db.transaction(...)` is
 *   `BYPASSRLS=TRUE`, so the FORCE RLS on `notifications_outbox`
 *   (migration 0098) is a no-op for the owner insert; the outbox row
 *   still carries the real `tenant_id` so the per-tenant dispatcher
 *   (chamber_app) reads it back via its RLS policy. This mirrors the
 *   documented `create-user` rationale verbatim.
 *
 *   PR-history note: an early draft minted inside `runInTenant` and added
 *   migration 0183 GRANTing chamber_app INSERT on `invitations`; migration
 *   0184 REVOKEd it, so the net grant is still none (0016/0017 posture).
 *   See 0184's header for the token-forgery threat that drove the revert.
 *
 * Pending guard (defence in depth): the user row is re-read INSIDE the
 * tx and the mint is refused unless `status === 'pending'`. This closes
 * the TOCTOU window where the user redeems their first (delivered?)
 * invitation between the caller's pre-check and this mint. It also
 * mirrors `redeem-invite`'s in-tx `status==='pending'` re-check.
 *
 * `intendedRole` is taken from the LOCKED user row, never from the
 * caller — `redeem-invite` requires `invitation.intendedRole ===
 * user.role`, so deriving it here guarantees the reissued token is
 * redeemable and removes a caller-supplied tamper vector.
 *
 * Audit: this F1 primitive emits NO audit event of its own. The
 * chamber-facing trail is owned by the F3 caller, which emits
 * `member_portal_invite_queued` (an existing F3 + DB enum value) after
 * this returns. Adding a dedicated `account_invitation_resent` F1 event
 * type would require an `audit_event_type` enum migration for no
 * additional forensic value — the F3 event already carries the
 * `new_invitation_id` correlation key. A structured `logger.info`
 * breadcrumb is emitted for operational tracing.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { authMetrics } from '@/lib/metrics';
import { db } from '@/lib/db';
import type { InvitationTokenHash, UserId } from '@/modules/auth/domain/branded';
import type { Role } from '@/modules/auth/domain/role';
import type { EmailLocale } from '@/modules/auth/infrastructure/email/reset-password-email';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { TokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import type { TenantSlug } from '@/modules/tenants/domain/tenant-slug';
import { TxAbort } from './tx-abort';
import type { EnqueueInvitationInTxFn } from './create-user';
import { defaultReissueInvitationDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface ReissueInvitationInput {
  /** The EXISTING pending user whose invitation is being re-sent. */
  readonly userId: UserId;
  /** Admin who triggered the re-send (audit correlation on the invitation row). */
  readonly invitedByUserId: UserId;
  /** Locale of the re-sent invitation email. */
  readonly locale?: EmailLocale | undefined;
  /** Chamber slug stamped on the outbox row (NOT NULL since migration 0098). */
  readonly tenantId: TenantSlug;
  /** Correlation id for the operational log breadcrumb. */
  readonly requestId: string;
}

export interface ReissueInvitationSuccess {
  /** Stored HASH of the new invitation (`sha256(plaintext)`). Audit-safe. */
  readonly invitationId: InvitationTokenHash;
  /** The identity email the new invitation was delivered to. */
  readonly email: string;
  /** The role copied from the locked user row (= the new invitation's intendedRole). */
  readonly role: Role;
}

export type ReissueInvitationError =
  /** No user row for `userId` (e.g. hard-deleted after the contact was linked). */
  | { readonly code: 'user-not-found' }
  /** User is no longer `pending` (already redeemed / disabled) — not eligible. */
  | { readonly code: 'not-pending' }
  /** Outbox enqueue failed — whole tx rolled back, no orphan invitation. */
  | { readonly code: 'reissue-failed' };

// --- Dependencies ------------------------------------------------------------

export interface ReissueInvitationDeps {
  readonly users: UserRepo;
  readonly tokens: TokenRepo;
  readonly enqueueInvitationInTx: EnqueueInvitationInTxFn;
  readonly now: () => Date;
}

export { defaultReissueInvitationDeps };

// --- Use case ----------------------------------------------------------------

export async function reissueInvitation(
  input: ReissueInvitationInput,
  deps: ReissueInvitationDeps = defaultReissueInvitationDeps,
): Promise<Result<ReissueInvitationSuccess, ReissueInvitationError>> {
  const now = deps.now();

  try {
    const outcome = await db.transaction(async (tx) => {
      // 1. Re-read + lock the user row. Refuse unless still pending.
      const user = await deps.users.findByIdInTx(tx, input.userId);
      if (!user) {
        throw new TxAbort<ReissueInvitationError>({ code: 'user-not-found' });
      }
      if (user.status !== 'pending') {
        throw new TxAbort<ReissueInvitationError>({ code: 'not-pending' });
      }

      // 2. Mint a fresh invitation. `intendedRole` is derived from the
      //    locked user row (NOT caller-supplied) so the reissued token
      //    satisfies redeem-invite's `intendedRole === user.role` guard.
      const { plaintext, invitation } = await deps.tokens.createInvitationInTx(
        tx,
        {
          userId: user.id,
          invitedByUserId: input.invitedByUserId,
          intendedRole: user.role,
          now,
        },
      );

      // 3. Enqueue the invitation email — atomic with the mint. On err
      //    the throw rolls back the invitation insert (no orphan token).
      const enqueueResult = await deps.enqueueInvitationInTx(tx, {
        toEmail: user.email,
        token: plaintext,
        role: user.role,
        locale: input.locale,
        tenantId: input.tenantId,
      });
      if (!enqueueResult.ok) {
        logger.error(
          {
            requestId: input.requestId,
            errCode: enqueueResult.error.code,
            errCause: enqueueResult.error.cause,
            targetUserIdHash: hashId(user.id),
          },
          'reissue_invitation.enqueue_failed',
        );
        authMetrics.invitationEnqueueFailed(user.role, enqueueResult.error.code);
        throw new TxAbort<ReissueInvitationError>({ code: 'reissue-failed' });
      }

      return {
        invitationId: invitation.id,
        email: user.email,
        role: user.role,
      };
    });

    // Post-commit only — aborted transactions are not counted.
    authMetrics.invitationSent(outcome.role);
    logger.info(
      {
        requestId: input.requestId,
        targetUserIdHash: hashId(input.userId),
        role: outcome.role,
      },
      'reissue_invitation.sent',
    );
    return ok(outcome);
  } catch (e) {
    if (e instanceof TxAbort) {
      return err(e.error as ReissueInvitationError);
    }
    logger.error(
      {
        requestId: input.requestId,
        errMessage: e instanceof Error ? e.message : String(e),
      },
      'reissue_invitation.unexpected_tx_failure',
    );
    throw e;
  }
}
