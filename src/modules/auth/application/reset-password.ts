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
import { authMetrics } from '@/lib/metrics';
import type { TokenId } from '@/modules/auth/domain/branded';
import {
  classifyTokenFailure,
  isResetTokenValid,
  type TokenFailureReason,
} from '@/modules/auth/domain/token';
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
import type { Role } from '@/modules/auth/domain/role';
import { PORTAL_FOR_ROLE } from '@/modules/auth/domain/role';
import { defaultResetPasswordDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface ResetPasswordInput {
  /**
   * Branded token id. The route handler applies the brand via
   * `asTokenId()` right after the zod-validated body is parsed, so
   * the use case never sees a raw `string` and does not need to
   * re-wrap it.
   */
  readonly token: TokenId;
  readonly newPassword: string;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface ResetPasswordSuccess {
  readonly signInUrl: string;
  readonly role: Role;
}

export type ResetPasswordError =
  | {
      /**
       * Public body stays uniform (`link-invalid`) to prevent token
       * enumeration. The `reason` discriminant is internal-only — it
       * drives the route handler's HTTP status split (404 vs 410)
       * and the audit summary.
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

export { defaultResetPasswordDeps };

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

  // 2. Token lookup + validity check. `input.token` is already branded
  //    (the route handler applied `asTokenId` after zod parsing), so
  //    there is no try/catch here.
  const now = deps.now();
  const token = await deps.tokens.findResetById(input.token);
  if (!token || !isResetTokenValid(token, now)) {
    const reason = classifyTokenFailure(token);
    logger.warn(
      { requestId: input.requestId, reason },
      'reset_password.token_invalid',
    );
    // Emit audit event when we have a target user to correlate against
    // (T161). The `invitation_redemption_failed` event type is reused
    // here — it's the only "redemption failed" event in the audit
    // enum and the summary string disambiguates reset vs invitation
    // on the query side. Missing tokens don't have a user to audit.
    // TODO(F9): once a dedicated `password_reset_failed` event type
    // is added to AUDIT_EVENT_TYPES, swap the reuse below for it.
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
    return err({ code: 'link-invalid', reason });
  }

  // 3. User lookup
  const user = await deps.users.findById(token.userId);
  if (!user || user.status !== 'active') {
    // Shouldn't happen in practice because the token was minted for a
    // live account, but guard against race with disable/delete.
    // Treat as 'used' — the link is no longer actionable but the row
    // existed, which is closer to 410 than 404.
    return err({ code: 'link-invalid', reason: 'used' });
  }

  // 4. Password policy
  const policy = await deps.checkPolicy(input.newPassword);
  if (!policy.ok) {
    // Tag the metric with the first failing rule — observability.md
    // § 4.5 uses this to break down weak-password rejections by cause.
    // Both `common-password` and `breached` map to the `pwned` bucket
    // because they share the same remediation (pick a different
    // password) and we don't want to leak HIBP presence via metric
    // dashboards.
    const firstReason = policy.errors[0]?.code;
    if (firstReason === 'too-short') {
      authMetrics.passwordWeakRejected('short');
    } else if (firstReason === 'common-password' || firstReason === 'breached') {
      authMetrics.passwordWeakRejected('pwned');
    }
    return err({ code: 'weak-password', errors: policy.errors });
  }

  // 5. Hash + persist
  const hashed = await deps.hasher.hash(input.newPassword);
  await deps.users.setPasswordHash(user.id, hashed, now);
  await deps.users.clearLock(user.id);
  await deps.users.clearFailedCount(user.id);

  // 6. Consume token + invalidate siblings (belt & braces)
  await deps.tokens.markResetConsumed(input.token, now);
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

  // observability.md § 4.2: successful reset completion counter + § 4.5
  // trigger breakdown (self vs reset).
  authMetrics.passwordResetCompleted();
  authMetrics.passwordChanged('reset');

  return ok({ signInUrl, role: user.role });
}
