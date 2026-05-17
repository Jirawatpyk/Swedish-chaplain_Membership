/**
 * change-password use case (T151, spec US6 AS1-AS3, contracts § 5).
 *
 * Algorithm:
 *   1. Rate-limit by USER (5 wrong-current / 15 min) — the key is
 *      `change-pw:user:<id>` so IP pivots don't bypass the counter.
 *   2. Look up the current user (caller provides session, route
 *      handler re-hydrates via getCurrentSession).
 *   3. Verify `currentPassword` against the stored hash. On miss,
 *      bump the per-user rate counter and return wrong-current.
 *   4. Reject if `newPassword === currentPassword` (same-password).
 *      This short-circuits BEFORE HIBP so the user never sees the
 *      breached-password error for their own current (otherwise-OK)
 *      password.
 *   5. Run the password policy on `newPassword` (length + common +
 *      HIBP). Weak → weak-password with which rule failed.
 *   6. Hash and persist the new password, update
 *      `last_password_changed_at`.
 *   7. Rotate the current session: create a fresh session id, delete
 *      the old one, delete every other session for this user. This
 *      is the "limit damage if old id leaked" step from FR-008.
 *   8. Emit `password_changed` + (optional) `concurrent_sessions_revoked`
 *      audit events.
 *
 * The new session ID is returned to the caller so the route handler
 * can set the cookie.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { authMetrics } from '@/lib/metrics';
import type { UserAccount } from '@/modules/auth/domain/user';
import type { Session } from '@/modules/auth/domain/session';
import {
  checkPasswordPolicy,
  weakPasswordMetricBucket,
  type PasswordPolicyError,
} from '@/modules/auth/application/password-policy';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import type { PasswordHasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import { MalformedHashError } from '@/modules/auth/infrastructure/password/argon2-hasher';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { retryAfterSeconds } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { defaultChangePasswordDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface ChangePasswordInput {
  readonly user: UserAccount;
  readonly currentSessionId: Session['id'];
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface ChangePasswordSuccess {
  readonly newSession: Session;
}

export type ChangePasswordError =
  | { readonly code: 'wrong-current-password' }
  | { readonly code: 'same-password' }
  | {
      readonly code: 'weak-password';
      readonly errors: readonly PasswordPolicyError[];
    }
  | { readonly code: 'rate-limited'; readonly retryAfterSeconds: number };

// --- Tunables ----------------------------------------------------------------

const RATE_LIMIT_PER_USER = { max: 5, windowSeconds: 15 * 60 };

// --- Dependencies ------------------------------------------------------------

export interface ChangePasswordDeps {
  readonly users: UserRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
  readonly hasher: PasswordHasher;
  readonly limiter: RateLimiter;
  readonly checkPolicy: typeof checkPasswordPolicy;
  readonly now: () => Date;
}

export { defaultChangePasswordDeps };

// --- Use case ----------------------------------------------------------------

export async function changePassword(
  input: ChangePasswordInput,
  deps: ChangePasswordDeps = defaultChangePasswordDeps,
): Promise<Result<ChangePasswordSuccess, ChangePasswordError>> {
  // 1. Per-user rate limit — peek-then-consume (B2). Peek to gate;
  //    the bucket is only debited on the wrong-current branch below,
  //    so legitimate password rotations do not trip the cap. See
  //    review-20260517-post-ship-hardening.md § B2 for rationale.
  const bucketKey = `change-pw:user:${input.user.id}`;
  const peek = await deps.limiter.peek(
    bucketKey,
    RATE_LIMIT_PER_USER.max,
    RATE_LIMIT_PER_USER.windowSeconds,
  );
  if (!peek.success) {
    return err({
      code: 'rate-limited',
      retryAfterSeconds: retryAfterSeconds(peek),
    });
  }

  // 2. Re-fetch to get the stored passwordHash (the user param has
  //    domain-level info but not the secret).
  const found = await deps.users.findByEmail(input.user.email);
  if (!found || !found.passwordHash) {
    // Shouldn't happen — getCurrentSession already validated the
    // user is active. Treat as wrong-current for user-facing parity.
    return err({ code: 'wrong-current-password' });
  }

  // 3. Verify current password. F3 (Round 2 HIGH1, 2026-05-17) — catch
  //    MalformedHashError separately so a DB-corruption incident does
  //    NOT bubble as an opaque 500 with no audit row. Pre-fix the
  //    B4 catch existed only in sign-in; change-password silently
  //    propagated the throw past the wrong-current branch.
  let currentOk: boolean;
  try {
    currentOk = await deps.hasher.verify(
      found.passwordHash,
      input.currentPassword,
    );
  } catch (verifyError) {
    if (verifyError instanceof MalformedHashError) {
      await deps.audit.append({
        eventType: 'password_malformed_hash_detected',
        actorUserId: input.user.id,
        targetUserId: input.user.id,
        sourceIp: input.sourceIp,
        summary:
          'stored password hash is malformed — user cannot change password until reset',
        requestId: input.requestId,
      });
      // Surface as wrong-current so the UI route is consistent with
      // sign-in's malformed-hash UX. The user should then use
      // /forgot-password which writes a fresh hash (E2 hash-at-rest
      // path) overwriting the corrupt row.
      return err({ code: 'wrong-current-password' });
    }
    throw verifyError;
  }
  if (!currentOk) {
    // 3a. NOW consume the bucket (B2). Wrong-current is the only
    //     event that should count against the user's brute-force
    //     budget. If `check` here pushes the count over `max`, the
    //     NEXT call's peek will return rate-limited.
    await deps.limiter.check(
      bucketKey,
      RATE_LIMIT_PER_USER.max,
      RATE_LIMIT_PER_USER.windowSeconds,
    );
    logger.warn(
      { userIdHash: hashId(input.user.id), requestId: input.requestId },
      'change_password.wrong_current',
    );
    // B5 — audit emit on wrong-current. Pre-B5 the failure was
    // logger.warn only — an attacker probing the user's password to
    // elevate via /change-password had zero audit-trail footprint.
    // Auto-swallow contract (A1) means a Neon hiccup here can't
    // mask the user-facing error path.
    await deps.audit.append({
      eventType: 'password_change_failed',
      actorUserId: input.user.id,
      targetUserId: input.user.id,
      sourceIp: input.sourceIp,
      summary: 'wrong current password on /change-password',
      requestId: input.requestId,
    });
    return err({ code: 'wrong-current-password' });
  }

  // 4. Same-password guard (short-circuits before HIBP)
  if (input.newPassword === input.currentPassword) {
    authMetrics.passwordWeakRejected('same');
    return err({ code: 'same-password' });
  }

  // 5. Policy check
  const policy = await deps.checkPolicy(input.newPassword);
  if (!policy.ok) {
    // Shared bucket mapping — see reset-password.ts for the rationale.
    // The `'same'` bucket is handled separately above (step 4) because
    // it's not a policy error but a short-circuit before HIBP.
    const bucket = weakPasswordMetricBucket(policy.errors);
    if (bucket) authMetrics.passwordWeakRejected(bucket);
    return err({ code: 'weak-password', errors: policy.errors });
  }

  // 6. Hash + persist
  const now = deps.now();
  const newHash = await deps.hasher.hash(input.newPassword);
  await deps.users.setPasswordHash(input.user.id, newHash, now);

  // 7. Rotate session — delete ALL existing sessions for this user
  //    (including the current one the caller is using) and create a
  //    fresh one. The caller (route handler) sets the new cookie so
  //    the user stays signed in on their current device.
  //
  //    The "killed" count for the audit event excludes the current
  //    session because that one was rotated, not revoked — the user
  //    is still in control of that device.
  const deletedCount = await deps.sessions.deleteByUserId(input.user.id);
  const newSession = await deps.sessions.create({
    userId: input.user.id,
    sourceIp: input.sourceIp,
    now,
  });
  const killed = Math.max(deletedCount - 1, 0);

  // 8. Audit
  await deps.audit.append({
    eventType: 'password_changed',
    actorUserId: input.user.id,
    targetUserId: input.user.id,
    sourceIp: input.sourceIp,
    summary: 'password changed while signed in',
    requestId: input.requestId,
  });
  if (killed > 0) {
    await deps.audit.append({
      eventType: 'concurrent_sessions_revoked',
      actorUserId: input.user.id,
      targetUserId: input.user.id,
      sourceIp: input.sourceIp,
      summary: `${killed} session(s) revoked on password change`,
      requestId: input.requestId,
    });
  }

  // observability.md § 4.5 — trigger breakdown (self vs reset).
  authMetrics.passwordChanged('self');

  return ok({ newSession });
}
