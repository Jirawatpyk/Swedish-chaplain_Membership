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
 *      "resend invitation" action (Phase 10 polish).
 *   6. Emit `account_created` audit event.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { asEmailAddress, type UserId } from '@/modules/auth/domain/branded';
import type { Role } from '@/modules/auth/domain/role';
import type { UserAccount } from '@/modules/auth/domain/user';
import {
  userRepo,
  type UserRepo,
} from '@/modules/auth/infrastructure/db/user-repo';
import {
  tokenRepo,
  type TokenRepo,
} from '@/modules/auth/infrastructure/db/token-repo';
import {
  auditRepo,
  type AuditRepo,
} from '@/modules/auth/infrastructure/db/audit-repo';
import {
  emailSender,
  type EmailSender,
} from '@/modules/auth/infrastructure/email/resend-client';
import {
  buildInvitationEmail,
} from '@/modules/auth/infrastructure/email/invitation-email';
import type { EmailLocale } from '@/modules/auth/infrastructure/email/reset-password-email';

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
  readonly invitationId: string;
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
  readonly now: () => Date;
}

export const defaultCreateUserDeps: CreateUserDeps = {
  users: userRepo,
  tokens: tokenRepo,
  audit: auditRepo,
  email: emailSender,
  now: () => new Date(),
};

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

  // 4. Send invitation email
  const built = buildInvitationEmail({
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

  return ok({ user, invitationId: invitation.id });
}

function hashId(id: string): string {
  let hash = 5381;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 33) ^ id.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}
