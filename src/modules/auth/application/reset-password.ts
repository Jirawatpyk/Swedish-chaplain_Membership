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
 *   6. Hash the new password (CPU-bound, pre-tx — see A4 note below).
 *   7. **Atomic state transition (A4 — Path C, post-ship 2026-05-17):**
 *      Open `db.transaction`. Inside the tx:
 *        a) `markResetConsumedInTx` (consume-then-set, W-01 ordering)
 *        b) `invalidateAllUnconsumedForUserInTx` (single-live-token)
 *        c) `setPasswordHashInTx`
 *        d) `clearLockInTx` + `clearFailedCountInTx`
 *        e) `deleteByUserIdInTx` (revoke all sessions)
 *        f) `appendInTx('password_reset_completed')` + optional
 *           `appendInTx('concurrent_sessions_revoked')`
 *      Any throw rolls the whole batch back. The pre-A4 code performed
 *      these as 7 separate `await`s with a header comment admitting
 *      "we live with the rare partial failure" — that excuse aged
 *      poorly once F4/F5 demonstrated multi-table tx works fine on
 *      Neon SG. A partial-failure here previously locked the user out
 *      (token dead, password unchanged) and burned their reset cycle.
 *
 *      WHY consume-then-set ordering still matters (security):
 *        If the tx aborts the token is untouched (no DB change) AND
 *        the password is unchanged — symmetric, no replay window. If
 *        the tx commits both happen together. The pre-A4 ordering was
 *        already correct (W-01 hardening); A4 just promotes it from
 *        "consume happens first in a sequence of separate awaits" to
 *        "consume + set + sessions-revoke commit atomically".
 *   8. Emit metrics post-commit (passwordResetCompleted + passwordChanged).
 *
 * Pure Application layer — DI-compatible for contract tests.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { authMetrics } from '@/lib/metrics';
import { db } from '@/lib/db';
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
import { TxAbort } from '@/modules/auth/application/tx-abort';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { TokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import type { PasswordHasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { retryAfterSeconds } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
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
       * drives the audit summary. The route handler returns 410 for
       * every reason (B1 — collapsed from 404/410 split to defeat
       * enumeration via status-code probing).
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
  // 1. Rate-limit per IP (pre-tx — no DB writes yet).
  const ipLimit = await deps.limiter.check(
    `reset:ip:${input.sourceIp}`,
    RATE_LIMIT_PER_IP.max,
    RATE_LIMIT_PER_IP.windowSeconds,
  );
  if (!ipLimit.success) {
    return err({
      code: 'rate-limited',
      retryAfterSeconds: retryAfterSeconds(ipLimit),
    });
  }

  // 2. Token lookup + validity check (pre-tx — read-only).
  const now = deps.now();
  const token = await deps.tokens.findResetById(input.token);
  if (!token || !isResetTokenValid(token, now)) {
    const reason = classifyTokenFailure(token);
    logger.warn(
      { requestId: input.requestId, reason },
      'reset_password.token_invalid',
    );
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

  // 3. User lookup (pre-tx — read-only).
  const user = await deps.users.findById(token.userId);
  if (!user || user.status !== 'active') {
    return err({ code: 'link-invalid', reason: 'used' });
  }

  // 4. Password policy (pre-tx — pure compute + HIBP fetch).
  const policy = await deps.checkPolicy(input.newPassword);
  if (!policy.ok) {
    const bucket = weakPasswordMetricBucket(policy.errors);
    if (bucket) authMetrics.passwordWeakRejected(bucket);
    return err({ code: 'weak-password', errors: policy.errors });
  }

  // 5. Hash the new password (pre-tx — argon2id is CPU-bound, see A3
  //    rationale in redeem-invite.ts).
  const hashed = await deps.hasher.hash(input.newPassword);

  // 6. Atomic state transition (A4 — Path C).
  let killed: number;
  try {
    killed = await db.transaction(async (tx) => {
      // 6a. Consume token FIRST (W-01 ordering preserved). If a later
      //     step in the tx throws, the markResetConsumedInTx is rolled
      //     back atomically.
      await deps.tokens.markResetConsumedInTx(tx, input.token, now);
      await deps.tokens.invalidateAllUnconsumedForUserInTx(tx, user.id, now);

      // 6b. Persist new password + clear lockout state.
      await deps.users.setPasswordHashInTx(tx, user.id, hashed, now);
      await deps.users.clearLockInTx(tx, user.id);
      await deps.users.clearFailedCountInTx(tx, user.id);

      // 6c. Revoke every existing session for this user.
      const killedInTx = await deps.sessions.deleteByUserIdInTx(tx, user.id);

      // 6d. Audit events — also in-tx (Principle VIII / Path C).
      await deps.audit.appendInTx(tx, {
        eventType: 'password_reset_completed',
        actorUserId: user.id,
        targetUserId: user.id,
        sourceIp: input.sourceIp,
        summary: 'password reset completed via email link',
        requestId: input.requestId,
      });
      if (killedInTx > 0) {
        await deps.audit.appendInTx(tx, {
          eventType: 'concurrent_sessions_revoked',
          actorUserId: user.id,
          targetUserId: user.id,
          sourceIp: input.sourceIp,
          summary: `${killedInTx} session(s) revoked on password reset`,
          requestId: input.requestId,
        });
      }

      return killedInTx;
    });
  } catch (e) {
    if (e instanceof TxAbort) {
      return err(e.error as ResetPasswordError);
    }
    logger.error(
      { err: e, requestId: input.requestId },
      'reset_password.tx_failed',
    );
    throw e;
  }

  const signInUrl = portalSignInPath(PORTAL_FOR_ROLE[user.role]);

  // Post-commit metrics — counted only when the tx committed.
  authMetrics.passwordResetCompleted();
  authMetrics.passwordChanged('reset');
  void killed; // killed-session count is recorded via the audit row above.

  return ok({ signInUrl, role: user.role });
}
