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
 *   7. CONSUME the token FIRST (markResetConsumed +
 *      invalidateAllUnconsumedForUser), THEN write the new password
 *      hash, clear lock, clear failed-count, and delete sessions —
 *      all in sequence. Neon doesn't support long transactions across
 *      multiple unrelated tables well, so we perform each step
 *      separately and live with the rare partial failure (logged and
 *      observed via audit completeness tests).
 *
 *      WHY consume-then-set ordering matters (security):
 *        If a process crashes between steps the failure mode MUST be
 *        "the token is now invalid" not "the token is still valid AND
 *        the password is set". The latter (set-then-consume) leaves a
 *        narrow replay window: an attacker who has the same token
 *        (T-15 interception) can race the legitimate user and set the
 *        password to something else AFTER the legitimate user's call
 *        succeeds. Consuming first means the worst-case is the user
 *        re-requests a fresh link.
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
  weakPasswordMetricBucket,
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
import { portalSignInPath } from '@/lib/portal-paths';

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
    // (T161). Uses the dedicated `password_reset_failed` event type
    // (added in pass 5). Missing tokens don't have a user to audit
    // — we deliberately skip the event in that branch to avoid
    // creating actor='anonymous' noise without a target row.
    if (token) {
      await deps.audit.append({
        eventType: 'password_reset_failed',
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
    // observability.md § 4.5 — tag the metric with the first failing
    // rule. Mapping lives in `weakPasswordMetricBucket` so the
    // `common-password`+`breached` → `pwned` collapse is defined in
    // exactly one place (shared with change-password.ts).
    const bucket = weakPasswordMetricBucket(policy.errors);
    if (bucket) authMetrics.passwordWeakRejected(bucket);
    return err({ code: 'weak-password', errors: policy.errors });
  }

  // 5. Consume token FIRST (W-01 hardening — see header comment).
  //    If a crash happens between this step and step 6, the token is
  //    invalid and the user requests a new link — strictly safer than
  //    the inverse ordering, which would leave a replayable token.
  await deps.tokens.markResetConsumed(input.token, now);
  await deps.tokens.invalidateAllUnconsumedForUser(user.id, now);

  // 6. Hash + persist
  const hashed = await deps.hasher.hash(input.newPassword);
  await deps.users.setPasswordHash(user.id, hashed, now);
  await deps.users.clearLock(user.id);
  await deps.users.clearFailedCount(user.id);

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

  const signInUrl = portalSignInPath(PORTAL_FOR_ROLE[user.role]);

  // observability.md § 4.2: successful reset completion counter + § 4.5
  // trigger breakdown (self vs reset).
  authMetrics.passwordResetCompleted();
  authMetrics.passwordChanged('reset');

  return ok({ signInUrl, role: user.role });
}
