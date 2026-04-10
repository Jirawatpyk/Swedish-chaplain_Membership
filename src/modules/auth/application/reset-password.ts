/**
 * reset-password use case (T100, spec US3 AS2-4, FR-005, FR-008, T-11).
 *
 * Algorithm:
 *   1. Rate-limit by IP (20/15min) — prevents token-bruteforce attacks.
 *   2. Look up reset token by id.
 *   3. Reject if missing, consumed, or expired (all three map to the
 *      same public "link-invalid" slug — the type field differs only
 *      for internal logs).
 *   4. Look up user; if not active → reject (same link-invalid slug).
 *   5. Check password policy (length + common-password + HIBP).
 *      On failure, return `weak-password` with the specific rule
 *      that failed so the UI can highlight it.
 *   6. Hash the new password.
 *   7. Update user.passwordHash + last_password_changed_at,
 *      mark the token consumed, delete all existing sessions,
 *      and clear any lockout — all in sequence. Neon doesn't support
 *      long transactions across multiple unrelated tables well, so we
 *      perform each step separately and live with the rare partial
 *      failure (logged and observed via audit completeness tests).
 *   8. Emit `password_reset_completed` + `concurrent_sessions_revoked`
 *      (the latter only when at least one session was killed).
 *
 * Pure Application layer — DI-compatible for contract tests.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { asTokenId } from '@/modules/auth/domain/branded';
import {
  isResetTokenValid,
} from '@/modules/auth/domain/token';
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
import type { Role } from '@/modules/auth/domain/role';
import { PORTAL_FOR_ROLE } from '@/modules/auth/domain/role';

// --- Public types -------------------------------------------------------------

export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface ResetPasswordSuccess {
  readonly signInUrl: string;
  readonly role: Role;
}

export type ResetPasswordError =
  | { readonly code: 'link-invalid' }
  | {
      readonly code: 'weak-password';
      readonly errors: readonly PasswordPolicyError[];
    }
  | { readonly code: 'rate-limited'; readonly retryAfterSeconds: number };

// --- Tunables ----------------------------------------------------------------

const RATE_LIMIT_PER_IP = { max: 20, windowSeconds: 15 * 60 };

// --- Dependencies ------------------------------------------------------------

export interface ResetPasswordDeps {
  readonly users: UserRepo;
  readonly tokens: TokenRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
  readonly hasher: PasswordHasher;
  readonly limiter: RateLimiter;
  readonly checkPolicy: typeof checkPasswordPolicy;
  readonly now: () => Date;
}

export const defaultResetPasswordDeps: ResetPasswordDeps = {
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

export async function resetPassword(
  input: ResetPasswordInput,
  deps: ResetPasswordDeps = defaultResetPasswordDeps,
): Promise<Result<ResetPasswordSuccess, ResetPasswordError>> {
  // 1. Rate-limit per IP
  const ipLimit = await deps.limiter.check(
    `reset:ip:${input.sourceIp}`,
    RATE_LIMIT_PER_IP.max,
    RATE_LIMIT_PER_IP.windowSeconds,
  );
  if (!ipLimit.success) {
    const retryAfter = Math.max(
      Math.ceil((ipLimit.reset - Date.now()) / 1000),
      1,
    );
    return err({ code: 'rate-limited', retryAfterSeconds: retryAfter });
  }

  // 2. Token lookup + validity check
  let tokenId;
  try {
    tokenId = asTokenId(input.token);
  } catch {
    return err({ code: 'link-invalid' });
  }

  const now = deps.now();
  const token = await deps.tokens.findResetById(tokenId);
  if (!token || !isResetTokenValid(token, now)) {
    const reason = !token
      ? 'token-not-found'
      : token.consumedAt
        ? 'token-used'
        : 'token-expired';
    logger.warn(
      { requestId: input.requestId, reason },
      'reset_password.token_invalid',
    );
    // Emit audit event when we have a target user to correlate against
    // (T161). The `invitation_redemption_failed` event type is reused
    // here — it's the only "redemption failed" event in the audit
    // enum and the summary string disambiguates reset vs invitation
    // on the query side. Missing tokens don't have a user to audit.
    if (token) {
      await deps.audit.append({
        eventType: 'invitation_redemption_failed',
        actorUserId: 'anonymous',
        targetUserId: token.userId,
        sourceIp: input.sourceIp,
        summary: `reset token ${reason}`,
        requestId: input.requestId,
      });
    }
    return err({ code: 'link-invalid' });
  }

  // 3. User lookup
  const user = await deps.users.findById(token.userId);
  if (!user || user.status !== 'active') {
    // Shouldn't happen in practice because the token was minted for a
    // live account, but guard against race with disable/delete.
    return err({ code: 'link-invalid' });
  }

  // 4. Password policy
  const policy = await deps.checkPolicy(input.newPassword);
  if (!policy.ok) {
    return err({ code: 'weak-password', errors: policy.errors });
  }

  // 5. Hash + persist
  const hashed = await deps.hasher.hash(input.newPassword);
  await deps.users.setPasswordHash(user.id, hashed, now);
  await deps.users.clearLock(user.id);
  await deps.users.clearFailedCount(user.id);

  // 6. Consume token + invalidate siblings (belt & braces)
  await deps.tokens.markResetConsumed(tokenId, now);
  await deps.tokens.invalidateAllUnconsumedForUser(user.id, now);

  // 7. Delete all existing sessions
  const killed = await deps.sessions.deleteByUserId(user.id);

  // 8. Audit events
  await deps.audit.append({
    eventType: 'password_reset_completed',
    actorUserId: user.id,
    targetUserId: user.id,
    sourceIp: input.sourceIp,
    summary: 'password reset completed via email link',
    requestId: input.requestId,
  });
  if (killed > 0) {
    await deps.audit.append({
      eventType: 'concurrent_sessions_revoked',
      actorUserId: user.id,
      targetUserId: user.id,
      sourceIp: input.sourceIp,
      summary: `${killed} session(s) revoked on password reset`,
      requestId: input.requestId,
    });
  }

  const portal = PORTAL_FOR_ROLE[user.role];
  const signInUrl = portal === 'staff' ? '/admin/sign-in' : '/portal/sign-in';

  return ok({ signInUrl, role: user.role });
}
