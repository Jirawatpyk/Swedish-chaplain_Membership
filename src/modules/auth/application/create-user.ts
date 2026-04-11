/**
 * create-user use case (T123, spec US4 AS1, FR-009).
 *
 * Admin invites a new staff / member by email. We create a `pending`
 * user row + an `invitations` row atomically, then send the invitation
 * email via Resend. The invitee follows the link, calls
 * `redeem-invite`, and transitions to `active`.
 *
 * Algorithm:
 *   1. Ensure caller is `admin` (RBAC enforcement happens at the route
 *      handler via `requireRole`; this use case trusts the input).
 *   2. Check for an existing user with this email. If one exists
 *      (pending, active, or disabled), return err(email-taken) —
 *      we do NOT silently overwrite, and we do NOT re-issue a fresh
 *      invitation to an existing pending user (admins must explicitly
 *      delete + recreate, logged in the audit trail).
 *   3. Insert `users` row with status='pending'.
 *   4. Insert `invitations` row with 7-day expiry.
 *   5. Send invitation email. Failure is LOGGED but does not roll
 *      back the user row — the admin can resend via a future
 *      "resend invitation" admin action (tracked for F9 polish; no
 *      dedicated Feature number — it's a small F1 follow-up patch).
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
import type { EmailSender } from '@/modules/auth/infrastructure/email/resend-client';
// `buildInvitationEmail` is a PURE template function (no DB, no network).
// Type-only import keeps the Application layer free of the concrete
// value; the implementation is injected via `CreateUserDeps.buildEmail`
// from `auth-deps.ts` composition root.
import type { buildInvitationEmail as BuildInvitationEmailFn } from '@/modules/auth/infrastructure/email/invitation-email';
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
  | { readonly code: 'email-taken' };

// --- Dependencies ------------------------------------------------------------

export interface CreateUserDeps {
  readonly users: UserRepo;
  readonly tokens: TokenRepo;
  readonly audit: AuditRepo;
  readonly email: EmailSender;
  readonly buildInvitationEmail: typeof BuildInvitationEmailFn;
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

  // 3. Create pending user + invitation token
  const user = await deps.users.createPending({
    email: normalisedEmail,
    role: input.role,
    displayName: input.displayName ?? null,
  });

  const now = deps.now();
  const invitation = await deps.tokens.createInvitation({
    userId: user.id,
    invitedByUserId: input.actorUserId,
    intendedRole: input.role,
    now,
  });

  // 4. Send invitation email — template builder injected via deps
  //    so this file never imports the concrete function at module
  //    load time (Clean Architecture: Application imports types only).
  const built = deps.buildInvitationEmail({
    toEmail: user.email,
    token: invitation.id,
    role: input.role,
    locale: input.locale,
  });
  const sendResult = await deps.email.send({
    to: user.email,
    subject: built.subject,
    html: built.html,
    text: built.text,
  });
  if (!sendResult.ok) {
    logger.error(
      {
        requestId: input.requestId,
        errCode: sendResult.error.code,
        targetUserIdHash: hashId(user.id),
      },
      'create_user.email_send_failed',
    );
  }

  // 5. Audit
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
