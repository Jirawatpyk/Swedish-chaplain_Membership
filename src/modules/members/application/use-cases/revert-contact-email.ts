/**
 * Revert-contact-email use case — FR-012b atomic rollback.
 *
 * The OLD-address user clicks the 48-hour revert link. Within a single
 * tenant-scoped transaction we:
 *   1. Re-fetch the revert token inside the tx (TOCTOU defence)
 *   2. Restore `contacts.email` to the oldEmail
 *   3. Restore `users.email` to the oldEmail, set email_verified=TRUE
 *      (the old email was already verified before the change) AND
 *      flag `requires_password_reset=TRUE` — F1 sign-in refuses while
 *      the flag is TRUE; the reset flow clears it on successful
 *      password change (see user-repo.setPasswordHash).
 *   4. Revoke every active session for the user (belt-and-suspenders —
 *      the original change already did this, but an attacker could
 *      have signed in on the NEW address between verification and
 *      revert if verification already completed. By revoking again
 *      we close that residual window.)
 *   5. Invalidate the matching verification token so it can't consume
 *      post-revert.
 *   6. Mark the revert token itself consumed.
 *   7. Append `member_email_change_reverted` high-severity audit.
 *
 * Error mapping:
 *   - `not_found`       — token missing/expired/consumed
 *   - `wrong_type`      — token is not of type `revert`
 *   - `conflict`        — oldEmail no longer available (another user
 *                         now holds it; rare but possible when admin
 *                         reassigned addresses in the 48h window)
 *   - `server_error`    — anything else, full rollback
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { asEmail } from '../../domain/value-objects/email';
import { asContactId } from '../../domain/contact';
import type { ContactId } from '../../domain/contact';
import type { AuditPort } from '../ports/audit-port';
import type { ContactRepo } from '../ports/contact-repo';
import type { EmailChangeTokenPort } from '../ports/email-change-token-port';
import type { SessionRevocationPort } from '../ports/session-revocation-port';
import type { UserEmailPort } from '../ports/user-email-port';
import type { ClockPort } from '../ports/clock-port';
import { hashEmail } from '../crypto-helpers';
import { UseCaseAbort } from '../tx-abort';

export type RevertContactEmailDeps = {
  tenant: TenantContext;
  tokens: EmailChangeTokenPort;
  contactRepo: ContactRepo;
  userEmails: UserEmailPort;
  sessions: SessionRevocationPort;
  audit: AuditPort;
  clock: ClockPort;
};

export type RevertContactEmailInput = {
  readonly tokenId: string;
  readonly requestId: string;
  readonly actorUserId?: string;
};

export type RevertContactEmailError =
  | { code: 'not_found' }
  | { code: 'wrong_type' }
  | { code: 'conflict'; reason: string }
  | { code: 'server_error'; cause?: unknown };

export type RevertContactEmailOutput = {
  readonly userId: string;
  readonly contactId: ContactId;
  readonly restoredEmail: string;
  readonly sessionsRevoked: number;
};

export async function revertContactEmail(
  deps: RevertContactEmailDeps,
  input: RevertContactEmailInput,
): Promise<Result<RevertContactEmailOutput, RevertContactEmailError>> {
  const now = deps.clock.now();

  try {
    const outcome = await runInTenant(deps.tenant, async (tx) => {
      const tokenResult = await deps.tokens.findActiveByIdInTx(
        tx,
        input.tokenId,
      );
      if (!tokenResult.ok) throw new UseCaseAbort({ code: 'not_found' });
      const token = tokenResult.value;

      if (token.type !== 'revert') {
        throw new UseCaseAbort({ code: 'wrong_type' });
      }

      const oldEmailVo = asEmail(token.oldEmail);
      if (!oldEmailVo.ok) {
        throw new UseCaseAbort({
          code: 'server_error',
          cause: 'revert token oldEmail failed domain validation',
        });
      }

      // Step 2 — contacts.email back to old
      const contactRestore = await deps.contactRepo.updateEmailInTx(
        tx,
        deps.tenant,
        asContactId(token.contactId),
        oldEmailVo.value,
      );
      if (!contactRestore.ok) {
        throw new UseCaseAbort(
          contactRestore.error.code === 'repo.conflict'
            ? { code: 'conflict', reason: contactRestore.error.reason }
            : { code: 'server_error', cause: contactRestore.error },
        );
      }

      // Step 3 — users.email restore + flags
      const userUpdate = await deps.userEmails.updateInTx(tx, {
        userId: token.userId,
        newEmail: token.oldEmail,
        setEmailVerified: true,
        setRequiresPasswordReset: true,
      });
      if (!userUpdate.ok) {
        throw new UseCaseAbort(
          userUpdate.error.code === 'repo.conflict'
            ? { code: 'conflict', reason: userUpdate.error.reason }
            : { code: 'server_error', cause: userUpdate.error },
        );
      }

      // Step 4 — residual session revocation
      const sessionsResult = await deps.sessions.revokeAllForInTx(
        tx,
        token.userId,
        'email_change',
      );
      if (!sessionsResult.ok) {
        throw new UseCaseAbort({
          code: 'server_error',
          cause: sessionsResult.error,
        });
      }

      // Step 5 — invalidate outstanding verification tokens so the
      // attacker can't consume one post-revert.
      const invalidated = await deps.tokens.invalidateActiveForUserInTx(
        tx,
        token.userId,
        'verification',
        now,
      );
      if (!invalidated.ok) {
        throw new UseCaseAbort({
          code: 'server_error',
          cause: invalidated.error,
        });
      }

      // Step 6 — mark the revert token itself consumed
      const marked = await deps.tokens.markConsumedInTx(
        tx,
        token.tokenId,
        now,
      );
      if (!marked.ok) {
        throw new UseCaseAbort({
          code: 'server_error',
          cause: marked.error,
        });
      }

      // Step 7 — high-severity audit via AuditPort.recordInTx
      // (Principle III). Email redacted by hashing per data-model.md § 4.
      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_email_change_reverted',
        actorUserId: input.actorUserId ?? 'anonymous',
        targetUserId: token.userId,
        requestId: input.requestId,
        summary: `email change reverted for user ${token.userId}`,
        payload: {
          contact_id: token.contactId,
          user_id: token.userId,
          reverted_to_email_hash: hashEmail(token.oldEmail),
          verification_tokens_invalidated:
            invalidated.value.invalidatedCount,
          sessions_revoked: sessionsResult.value.revokedCount,
        },
      });
      if (!auditResult.ok) {
        throw new UseCaseAbort({
          code: 'server_error',
          cause: auditResult.error,
        });
      }

      return {
        userId: token.userId,
        contactId: asContactId(token.contactId),
        restoredEmail: token.oldEmail,
        sessionsRevoked: sessionsResult.value.revokedCount,
      };
    });

    return ok(outcome);
  } catch (e) {
    if (e instanceof UseCaseAbort) return err(e.error as RevertContactEmailError);
    return err({ code: 'server_error', cause: e });
  }
}
