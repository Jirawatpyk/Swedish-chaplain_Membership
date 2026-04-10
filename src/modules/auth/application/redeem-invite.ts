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
import { authMetrics } from '@/lib/metrics';
import type { TokenId } from '@/modules/auth/domain/branded';
import {
  classifyTokenFailure,
  isInvitationValid,
  type TokenFailureReason,
} from '@/modules/auth/domain/token';
import type { Session } from '@/modules/auth/domain/session';
import type { UserAccount } from '@/modules/auth/domain/user';
import { PORTAL_FOR_ROLE } from '@/modules/auth/domain/role';
import {
  checkPasswordPolicy,
  type PasswordPolicyError,
} from '@/modules/auth/application/password-policy';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { TokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import type { PasswordHasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { defaultRedeemInviteDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface RedeemInviteInput {
  /**
   * Branded token id. Route handler applies `asTokenId()` after
   * zod parsing, so the use case never sees a raw string.
   */
  readonly token: TokenId;
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
  | {
      /**
       * Public body stays uniform (`link-invalid`). The `reason`
       * discriminant is internal-only — it drives the 404 vs 410
       * split in the route handler + the audit summary.
       */
      readonly code: 'link-invalid';
      readonly reason: TokenFailureReason;
    }
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

export { defaultRedeemInviteDeps };

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

  // 2. Token lookup. `input.token` is already branded (route handler
  //    applied `asTokenId` after zod parsing).
  const now = deps.now();
  const invitation = await deps.tokens.findInvitationById(input.token);
  if (!invitation || !isInvitationValid(invitation, now)) {
    const reason = classifyTokenFailure(invitation);
    logger.warn(
      { requestId: input.requestId, reason },
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
        summary:
          reason === 'used' ? 'invitation already used' : 'invitation expired',
        requestId: input.requestId,
      });
      // observability.md § 4.3 — failure breakdown. Only report the
      // two reasons the audit event covers (used / expired); the
      // `not-found` branch has no invitation row and emits no audit.
      if (reason === 'used' || reason === 'expired') {
        authMetrics.invitationRedemptionFailed(reason);
      }
    }
    return err({ code: 'link-invalid', reason });
  }

  // 3. User lookup + role tamper detection
  const user = await deps.users.findById(invitation.userId);
  if (!user || user.status !== 'pending' || user.role !== invitation.intendedRole) {
    // Row existed but the account state diverged — closer to 410
    // than 404 because the link itself was once valid.
    return err({ code: 'link-invalid', reason: 'used' });
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
  await deps.tokens.markInvitationConsumed(input.token, now);

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
    // Shouldn't happen — we just activated the row. Treat as used.
    return err({ code: 'link-invalid', reason: 'used' });
  }

  const portal = PORTAL_FOR_ROLE[activated.role];
  const redirectTo = portal === 'staff' ? '/admin' : '/portal';

  // observability.md § 4.3 — invitation → account conversion.
  authMetrics.invitationRedeemed(activated.role);

  return ok({ user: activated, session, redirectTo });
}
