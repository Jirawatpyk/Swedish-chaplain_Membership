/**
 * redeem-invite use case (T124, spec US4 AS2).
 *
 * Invitee sets their initial password and activates the account.
 * Symmetric to `reset-password` but:
 *   - the account is `pending` (never active) before redemption
 *   - the invitation carries an `intendedRole` that MUST match the
 *     user's stored role (tamper detection: if an attacker somehow
 *     altered the user row after invitation, the redemption fails)
 *   - on success, we also create an initial session so the user
 *     lands signed in (contract §7 auto-sign-in behaviour)
 *
 * The "link-invalid" public slug covers the four underlying failures
 * (missing, consumed, expired, user state mismatch) to avoid leaking
 * which failure occurred.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { asTokenId } from '@/modules/auth/domain/branded';
import {
  isInvitationValid,
} from '@/modules/auth/domain/token';
import type { Session } from '@/modules/auth/domain/session';
import type { UserAccount } from '@/modules/auth/domain/user';
import { PORTAL_FOR_ROLE } from '@/modules/auth/domain/role';
import {
  checkPasswordPolicy,
  type PasswordPolicyError,
} from '@/modules/auth/application/password-policy';
import {
  userRepo,
  type UserRepo,
} from '@/modules/auth/infrastructure/db/user-repo';
import {
  tokenRepo,
  type TokenRepo,
} from '@/modules/auth/infrastructure/db/token-repo';
import {
  sessionRepo,
  type SessionRepo,
} from '@/modules/auth/infrastructure/db/session-repo';
import {
  auditRepo,
  type AuditRepo,
} from '@/modules/auth/infrastructure/db/audit-repo';
import {
  argon2Hasher,
  type PasswordHasher,
} from '@/modules/auth/infrastructure/password/argon2-hasher';
import {
  rateLimiter,
  type RateLimiter,
} from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';

// --- Public types -------------------------------------------------------------

export interface RedeemInviteInput {
  readonly token: string;
  readonly password: string;
  readonly displayName?: string | null;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface RedeemInviteSuccess {
  readonly user: UserAccount;
  readonly session: Session;
  readonly redirectTo: string;
}

export type RedeemInviteError =
  | { readonly code: 'link-invalid' }
  | {
      readonly code: 'weak-password';
      readonly errors: readonly PasswordPolicyError[];
    }
  | { readonly code: 'rate-limited'; readonly retryAfterSeconds: number };

// --- Tunables ----------------------------------------------------------------

const RATE_LIMIT_PER_IP = { max: 20, windowSeconds: 15 * 60 };

// --- Dependencies ------------------------------------------------------------

export interface RedeemInviteDeps {
  readonly users: UserRepo;
  readonly tokens: TokenRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
  readonly hasher: PasswordHasher;
  readonly limiter: RateLimiter;
  readonly checkPolicy: typeof checkPasswordPolicy;
  readonly now: () => Date;
}

export const defaultRedeemInviteDeps: RedeemInviteDeps = {
  users: userRepo,
  tokens: tokenRepo,
  sessions: sessionRepo,
  audit: auditRepo,
  hasher: argon2Hasher,
  limiter: rateLimiter,
  checkPolicy: checkPasswordPolicy,
  now: () => new Date(),
};

// --- Use case ----------------------------------------------------------------

export async function redeemInvite(
  input: RedeemInviteInput,
  deps: RedeemInviteDeps = defaultRedeemInviteDeps,
): Promise<Result<RedeemInviteSuccess, RedeemInviteError>> {
  // 1. Rate limit
  const ipLimit = await deps.limiter.check(
    `redeem:ip:${input.sourceIp}`,
    RATE_LIMIT_PER_IP.max,
    RATE_LIMIT_PER_IP.windowSeconds,
  );
  if (!ipLimit.success) {
    return err({
      code: 'rate-limited',
      retryAfterSeconds: Math.max(
        Math.ceil((ipLimit.reset - Date.now()) / 1000),
        1,
      ),
    });
  }

  // 2. Token lookup
  let tokenId;
  try {
    tokenId = asTokenId(input.token);
  } catch {
    return err({ code: 'link-invalid' });
  }

  const now = deps.now();
  const invitation = await deps.tokens.findInvitationById(tokenId);
  if (!invitation || !isInvitationValid(invitation, now)) {
    logger.warn(
      {
        requestId: input.requestId,
        reason: !invitation
          ? 'token-not-found'
          : invitation.consumedAt
            ? 'token-used'
            : 'token-expired',
      },
      'redeem_invite.token_invalid',
    );
    // Emit audit event for expired / used (but not for missing — no
    // target user id to correlate against).
    if (invitation) {
      await deps.audit.append({
        eventType: 'invitation_redemption_failed',
        actorUserId: 'anonymous',
        targetUserId: invitation.userId,
        sourceIp: input.sourceIp,
        summary: invitation.consumedAt
          ? 'invitation already used'
          : 'invitation expired',
        requestId: input.requestId,
      });
    }
    return err({ code: 'link-invalid' });
  }

  // 3. User lookup + role tamper detection
  const user = await deps.users.findById(invitation.userId);
  if (!user || user.status !== 'pending' || user.role !== invitation.intendedRole) {
    return err({ code: 'link-invalid' });
  }

  // 4. Password policy
  const policy = await deps.checkPolicy(input.password);
  if (!policy.ok) {
    return err({ code: 'weak-password', errors: policy.errors });
  }

  // 5. Hash + activate
  const hashed = await deps.hasher.hash(input.password);
  await deps.users.setPasswordHash(user.id, hashed, now);
  await deps.users.activate(user.id, now);
  await deps.tokens.markInvitationConsumed(tokenId, now);

  // 6. Initial session (auto sign-in)
  const session = await deps.sessions.create({
    userId: user.id,
    sourceIp: input.sourceIp,
    now,
  });

  // 7. Audit (sign_in_success — account_created was already emitted at invitation time)
  await deps.audit.append({
    eventType: 'sign_in_success',
    actorUserId: user.id,
    targetUserId: user.id,
    sourceIp: input.sourceIp,
    summary: 'invitation redeemed + initial session created',
    requestId: input.requestId,
  });

  // Re-read the user to get the updated status
  const activated = await deps.users.findById(user.id);
  if (!activated) {
    return err({ code: 'link-invalid' });
  }

  const portal = PORTAL_FOR_ROLE[activated.role];
  const redirectTo = portal === 'staff' ? '/admin' : '/portal';

  return ok({ user: activated, session, redirectTo });
}
