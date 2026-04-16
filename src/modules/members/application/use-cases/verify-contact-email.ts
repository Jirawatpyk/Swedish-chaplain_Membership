/**
 * Verify-contact-email use case — consumes a `verification` token from
 * `email_change_tokens` and flips `users.email_verified` back to TRUE,
 * unblocking F1 sign-in for the user whose email was just changed
 * (FR-012a companion; spec: "Sign-in with the new email MUST be blocked
 * until the verification token is consumed.").
 *
 * Steps inside a single tenant-scoped transaction:
 *   1. Re-fetch the token by id inside the tx (defence against TOCTOU
 *      between the outer public-endpoint lookup and the consumption)
 *   2. Reject if `now() < activatedAt` (5-minute activation delay per
 *      spec FR-012a) — returns `not_yet_active`
 *   3. Mark the token consumed
 *   4. Flip users.email_verified = TRUE
 *   5. Invalidate any still-active revert token for the same user —
 *      the 48h revert window closes once verification completes
 *   6. Append audit event. NOTE: reuses `email_verification_sent`
 *      event type (migration 0010) rather than adding a new
 *      `email_verification_consumed` type — the `summary` field
 *      disambiguates ("email verification consumed for user …").
 *      A dedicated type can be added in a future migration if
 *      audit queries need to distinguish send from consumption.
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { EmailChangeTokenPort } from '../ports/email-change-token-port';
import type { UserEmailPort } from '../ports/user-email-port';
import type { ClockPort } from '../ports/clock-port';

export type VerifyContactEmailDeps = {
  tenant: TenantContext;
  tokens: EmailChangeTokenPort;
  userEmails: UserEmailPort;
  clock: ClockPort;
};

export type VerifyContactEmailInput = {
  /** sha256 hex digest of the presented plaintext token. */
  readonly tokenId: string;
  readonly requestId: string;
  /** Optional actor id for audit — the endpoint has no session so this
   *  defaults to 'anonymous'. */
  readonly actorUserId?: string;
};

export type VerifyContactEmailError =
  | { code: 'not_found' }
  | { code: 'wrong_type' }
  | { code: 'not_yet_active'; activatedAt: Date }
  | { code: 'server_error'; cause?: unknown };

export type VerifyContactEmailOutput = {
  readonly userId: string;
  readonly contactId: string;
  readonly newEmail: string;
  readonly revertTokensInvalidated: number;
};

export async function verifyContactEmail(
  deps: VerifyContactEmailDeps,
  input: VerifyContactEmailInput,
): Promise<Result<VerifyContactEmailOutput, VerifyContactEmailError>> {
  const now = deps.clock.now();

  try {
    const outcome = await runInTenant(deps.tenant, async (tx) => {
      const tokenResult = await deps.tokens.findActiveByIdInTx(
        tx,
        input.tokenId,
      );
      if (!tokenResult.ok) throw new UseCaseAbort({ code: 'not_found' });
      const token = tokenResult.value;

      if (token.type !== 'verification') {
        throw new UseCaseAbort({ code: 'wrong_type' });
      }
      if (now < token.activatedAt) {
        throw new UseCaseAbort({
          code: 'not_yet_active',
          activatedAt: token.activatedAt,
        });
      }

      const marked = await deps.tokens.markConsumedInTx(
        tx,
        token.tokenId,
        now,
      );
      if (!marked.ok) {
        throw new UseCaseAbort({ code: 'server_error', cause: marked.error });
      }

      const flagged = await deps.userEmails.setFlagsInTx(tx, token.userId, {
        emailVerified: true,
      });
      if (!flagged.ok) {
        throw new UseCaseAbort({ code: 'server_error', cause: flagged.error });
      }

      // Close the revert window — the verification has confirmed the
      // NEW address is owned by the real user.
      const revertInvalidated = await deps.tokens.invalidateActiveForUserInTx(
        tx,
        token.userId,
        'revert',
        now,
      );
      if (!revertInvalidated.ok) {
        throw new UseCaseAbort({
          code: 'server_error',
          cause: revertInvalidated.error,
        });
      }

      await tx.insert(auditLog).values({
        eventType: 'email_verification_sent',
        actorUserId: input.actorUserId ?? 'anonymous',
        targetUserId: token.userId,
        summary: `email verification consumed for user ${token.userId}`,
        requestId: input.requestId,
        tenantId: deps.tenant.slug,
        payload: {
          contact_id: token.contactId,
          user_id: token.userId,
          token_id: token.tokenId,
          revert_tokens_invalidated: revertInvalidated.value.invalidatedCount,
        },
      });

      return {
        userId: token.userId,
        contactId: token.contactId,
        newEmail: token.newEmail,
        revertTokensInvalidated: revertInvalidated.value.invalidatedCount,
      };
    });

    return ok(outcome);
  } catch (e) {
    if (e instanceof UseCaseAbort) return err(e.error);
    return err({ code: 'server_error', cause: e });
  }
}

class UseCaseAbort extends Error {
  constructor(public readonly error: VerifyContactEmailError) {
    super(error.code);
  }
}
