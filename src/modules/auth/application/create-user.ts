/**
 * create-user use case (T123, spec US4 AS1, FR-009).
 *
 * Admin invites a new staff / member by email.
 *
 * Algorithm:
 *   1. Parse + normalise email.
 *   2. Duplicate check — reject with `email-taken` on any match.
 *   3. Insert `users` row (status='pending').
 *   4. Insert `invitations` row (7-day TTL). On failure, compensate by
 *      deleting the pending user via `users.deletePending` — this keeps
 *      the pair atomic across two non-transactional repos. Without the
 *      compensation a transient failure at step 4 would leave an
 *      orphan pending user that blocks the admin from retrying with
 *      the same email.
 *   5. Enqueue invitation email to the F3 outbox (T049). Failure is
 *      LOGGED (with `cause`) but does not roll back the user +
 *      invitation — admin can resend via a future "resend invitation"
 *      admin action. Outbox dispatcher renders + sends within ≤60s tick.
 *   6. Emit `account_created` audit event.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { authMetrics } from '@/lib/metrics';
import { asEmailAddress, type TokenId, type UserId } from '@/modules/auth/domain/branded';
import type { Role } from '@/modules/auth/domain/role';
import type { UserAccount } from '@/modules/auth/domain/user';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { TokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import type { EmailLocale } from '@/modules/auth/infrastructure/email/reset-password-email';
import { defaultCreateUserDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface CreateUserInput {
  readonly email: string;
  readonly role: Role;
  readonly displayName?: string | null;
  readonly actorUserId: UserId;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly locale?: EmailLocale | undefined;
}

export interface CreateUserSuccess {
  readonly user: UserAccount;
  /** Branded token id — carry the type across the module boundary
   * so callers can't accidentally log or compare it as a raw string. */
  readonly invitationId: TokenId;
}

export type CreateUserError =
  | { readonly code: 'invalid-input' }
  | { readonly code: 'email-taken' }
  | { readonly code: 'invitation-create-failed' };

// --- Dependencies ------------------------------------------------------------

/**
 * Outbox enqueue port for invitation emails. Inserts a row into
 * `notifications_outbox` with `notification_type='member_invitation'`.
 */
export interface EnqueueInvitationRequest {
  readonly toEmail: string;
  readonly token: TokenId;
  readonly role: Role;
  readonly locale?: EmailLocale | undefined;
}

/**
 * Literal union of known enqueue failure codes. Keeping this closed
 * lets consumers exhaustively handle the error space; the `cause`
 * field is sanitised (string) to avoid raw DB exception leakage.
 */
export type EnqueueInvitationErrorCode = 'enqueue_failed' | 'no_row_returned';

export interface EnqueueInvitationError {
  readonly code: EnqueueInvitationErrorCode;
  readonly cause?: string;
}

export type EnqueueInvitationFn = (
  request: EnqueueInvitationRequest,
) => Promise<Result<{ outboxRowId: string }, EnqueueInvitationError>>;

export interface CreateUserDeps {
  readonly users: UserRepo;
  readonly tokens: TokenRepo;
  readonly audit: AuditRepo;
  readonly enqueueInvitation: EnqueueInvitationFn;
  readonly now: () => Date;
}

export { defaultCreateUserDeps };

// --- Use case ----------------------------------------------------------------

export async function createUser(
  input: CreateUserInput,
  deps: CreateUserDeps = defaultCreateUserDeps,
): Promise<Result<CreateUserSuccess, CreateUserError>> {
  // 1. Parse + normalise email
  let normalisedEmail;
  try {
    normalisedEmail = asEmailAddress(input.email);
  } catch {
    return err({ code: 'invalid-input' });
  }

  // 2. Duplicate check
  const existing = await deps.users.findByEmail(normalisedEmail);
  if (existing) {
    return err({ code: 'email-taken' });
  }

  // 3. Create pending user
  const user = await deps.users.createPending({
    email: normalisedEmail,
    role: input.role,
    displayName: input.displayName ?? null,
  });

  const now = deps.now();

  // 4. Create invitation — compensate on failure to keep the user +
  //    invitation pair atomic across two repos that do not share a tx.
  let invitation;
  try {
    invitation = await deps.tokens.createInvitation({
      userId: user.id,
      invitedByUserId: input.actorUserId,
      intendedRole: input.role,
      now,
    });
  } catch (e) {
    logger.error(
      {
        requestId: input.requestId,
        errMessage: e instanceof Error ? e.message : String(e),
        targetUserIdHash: hashId(user.id),
      },
      'create_user.invitation_create_failed',
    );
    // Compensate: delete the pending user row so the admin can retry
    // with the same email. Safe-guarded inside the repo against deleting
    // an already-activated account (race with redeemInvite).
    try {
      await deps.users.deletePending(user.id);
    } catch (deleteError) {
      logger.error(
        {
          requestId: input.requestId,
          errMessage:
            deleteError instanceof Error ? deleteError.message : String(deleteError),
          targetUserIdHash: hashId(user.id),
        },
        'create_user.compensating_delete_failed',
      );
    }
    return err({ code: 'invitation-create-failed' });
  }

  // 5. Enqueue invitation email to the F3 outbox (T049).
  const enqueueResult = await deps.enqueueInvitation({
    toEmail: user.email,
    token: invitation.id,
    role: input.role,
    locale: input.locale,
  });
  if (!enqueueResult.ok) {
    logger.error(
      {
        requestId: input.requestId,
        errCode: enqueueResult.error.code,
        errCause: enqueueResult.error.cause,
        targetUserIdHash: hashId(user.id),
      },
      'create_user.invitation_enqueue_failed',
    );
  }

  // 6. Audit
  await deps.audit.append({
    eventType: 'account_created',
    actorUserId: input.actorUserId,
    targetUserId: user.id,
    sourceIp: input.sourceIp,
    summary: `invited ${input.role} ${user.email}`,
    requestId: input.requestId,
  });

  // observability.md § 4.3 — invitation volume by role.
  authMetrics.invitationSent(input.role);

  return ok({ user, invitationId: invitation.id });
}
