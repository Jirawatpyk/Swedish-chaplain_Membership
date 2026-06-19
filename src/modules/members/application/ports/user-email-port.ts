/**
 * Application port — update the F1 user's email + email_verified flag.
 *
 * Used by `change-contact-email.ts` (FR-012a step ii) to atomically
 * flip the linked user's identity email. The adapter runs inside the
 * use case's runInTenant transaction, so chamber_app's UPDATE grant on
 * users(email, email_verified) carries this.
 *
 * Errors:
 *   - `repo.not_found`    — no user row
 *   - `repo.conflict`     — new email already taken by another user
 *                           (lower-case unique index collision)
 *   - `repo.unexpected`   — everything else
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { RepoError } from './member-repo';

export type UserEmailUpdate = {
  readonly userId: string;
  readonly newEmail: string;
  /**
   * On a contact-email change the caller sets this to FALSE to block
   * sign-in until the verification token is consumed.
   * On a revert / verification consumption it is set back to TRUE.
   */
  readonly setEmailVerified: boolean;
  /**
   * Optional — set to TRUE by the revert use case (FR-012b) so the
   * attacker (who might have known the old password) is forced
   * through a password reset before the account is usable again.
   * When omitted, `requires_password_reset` is NOT modified.
   */
  readonly setRequiresPasswordReset?: boolean;
};

export interface UserEmailPort {
  updateInTx(
    tx: TenantTx,
    update: UserEmailUpdate,
  ): Promise<Result<{ oldEmail: string }, RepoError>>;

  /**
   * Narrower update path — flip `email_verified` only (and optionally
   * `requires_password_reset`). Used by the verification-consume use
   * case which does NOT touch the email column. Separate surface so
   * `updateInTx` cannot be called with a missing `newEmail` by
   * accident.
   */
  setFlagsInTx(
    tx: TenantTx,
    userId: string,
    flags: {
      readonly emailVerified?: boolean;
      readonly requiresPasswordReset?: boolean;
    },
  ): Promise<Result<undefined, RepoError>>;

  /**
   * Read-only check: is the user's email already verified?
   * Used by `resendVerificationEmail` to guard against re-issuing
   * tokens for already-verified users (COR-2).
   */
  isEmailVerified(
    userId: string,
  ): Promise<Result<boolean, RepoError>>;

  /**
   * Read-only batch: which of these users have a verified email?
   * Returns the SET of userIds whose email_verified = true.
   * Empty input ⇒ ok(empty set) WITHOUT a query.
   * `users` is cross-tenant (no tenant_id). DV-11 visible-gate batch read.
   */
  isEmailVerifiedBatch(
    userIds: readonly string[],
  ): Promise<Result<ReadonlySet<string>, RepoError>>;

  /**
   * Read-only check: is the user still in `pending` status?
   * Used by `resendBouncedInvite` to guard against re-issuing an
   * invitation for a user who has already redeemed their invite
   * (status transitioned from `pending` → `active`). Re-issuing for
   * a non-pending user would give them a second "portal invitation"
   * email for an account they already control.
   */
  isUserPending(
    userId: string,
  ): Promise<Result<boolean, RepoError>>;
}
