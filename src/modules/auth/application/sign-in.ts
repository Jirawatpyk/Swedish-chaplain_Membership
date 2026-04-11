/**
 * Sign-in use case (T068, spec FR-005 / FR-013 / FR-016, security.md
 * T-01 / T-02 / T-03 / T-06).
 *
 * Algorithm:
 *
 *   1. Rate-limit by email AND by IP. If either bucket is full → 429.
 *   2. Look up user by email (case-insensitive).
 *   3. If user does not exist:
 *      - call passwordHasher.verifyDummy(suppliedPassword) so the unknown-
 *        email path takes the same time as the wrong-password path
 *        (security.md T-03)
 *      - audit `sign_in_failure` with actor 'anonymous'
 *      - return Err(invalid-credentials) — same generic message as wrong
 *        password (spec FR-016)
 *   4. If user is `disabled` → audit failure, return Err(account-disabled).
 *   5. If user is locked (`lockedUntil > now`) → audit failure, return
 *      Err(account-locked).
 *   6. Verify password. On miss:
 *      - increment failed count
 *      - if count >= 5 → set lockedUntil = now + 15 min, audit
 *        `lockout_triggered`
 *      - audit `sign_in_failure`
 *      - return Err(invalid-credentials)
 *   7. Verify portal: admin/manager must sign in via 'staff', member via
 *      'member'. Mismatch → return Err(invalid-credentials) (no portal leak).
 *   8. On success:
 *      - clear failed count
 *      - create session (32-byte random ID)
 *      - update last_sign_in_at
 *      - audit `sign_in_success`
 *      - return Ok({ sessionId, user })
 *
 * Application layer NEVER throws across its boundary — every error
 * path returns a Result. The Route Handler (T070) maps the union to
 * the appropriate HTTP status.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import { authMetrics, type SignInLabels } from '@/lib/metrics';
import { type EmailAddress, asEmailAddress } from '@/modules/auth/domain/branded';
import {
  PORTAL_FOR_ROLE,
  type Portal,
  type Role,
} from '@/modules/auth/domain/role';
import type { UserAccount } from '@/modules/auth/domain/user';
import { isLocked } from '@/modules/auth/domain/user';
import type { Session } from '@/modules/auth/domain/session';
// Type-only imports — Clean Architecture: Application never pulls
// concrete Infrastructure singletons into its own module graph.
// Default wiring lives in the composition root (@/lib/auth-deps).
import type { PasswordHasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultSignInDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

// Re-export for backward compat with older callers that imported
// `Portal` from this file. The canonical definition lives in
// `@/modules/auth/domain/role`.
export type { Portal };

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly portal: Portal;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface SignInSuccess {
  readonly session: Session;
  readonly user: UserAccount;
}

export type SignInError =
  | { readonly code: 'invalid-credentials' }
  | { readonly code: 'account-disabled' }
  | { readonly code: 'account-locked'; readonly retryAfterSeconds: number }
  | { readonly code: 'rate-limited'; readonly retryAfterSeconds: number };

// --- Tunables (mirror data-model.md / research.md § 5) -----------------------

const FAILED_ATTEMPTS_BEFORE_LOCKOUT = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Rate limit thresholds (research.md § 5)
const RATE_LIMIT_PER_EMAIL = { max: 5, windowSeconds: 15 * 60 };
const RATE_LIMIT_PER_IP = { max: 30, windowSeconds: 15 * 60 };

// --- Dependencies (default to production singletons; tests override) ---------

export interface SignInDeps {
  readonly users: UserRepo;
  readonly sessions: SessionRepo;
  readonly audit: AuditRepo;
  readonly hasher: PasswordHasher;
  readonly limiter: RateLimiter;
  readonly now: () => Date;
}

// Default deps live in the composition root — see `@/lib/auth-deps`.
// Re-export for callers (tests, other use cases) that still import
// from the use case file. This is a pure re-export; no extra runtime
// dependency beyond the single edge to auth-deps above.
export { defaultSignInDeps };

// --- Use case ----------------------------------------------------------------

/**
 * Map a sign-in error code to the metric label vocabulary in
 * docs/observability.md § 4 table.
 */
function outcomeLabel(
  result: Result<SignInSuccess, SignInError>,
): SignInLabels['outcome'] {
  if (result.ok) return 'success';
  switch (result.error.code) {
    case 'invalid-credentials':
      return 'invalid_credentials';
    case 'account-locked':
      return 'account_locked';
    case 'account-disabled':
      return 'account_disabled';
    case 'rate-limited':
      return 'rate_limited';
  }
}

export async function signIn(
  input: SignInInput,
  deps: SignInDeps = defaultSignInDeps,
): Promise<Result<SignInSuccess, SignInError>> {
  const start = performance.now();
  const result = await signInImpl(input, deps);
  const durationSeconds = (performance.now() - start) / 1000;
  const outcome = outcomeLabel(result);
  authMetrics.signInAttempt({ portal: input.portal, outcome });
  authMetrics.signInDuration(durationSeconds, { portal: input.portal, outcome });
  return result;
}

async function signInImpl(
  input: SignInInput,
  deps: SignInDeps,
): Promise<Result<SignInSuccess, SignInError>> {
  let normalisedEmail: EmailAddress;
  try {
    normalisedEmail = asEmailAddress(input.email);
  } catch {
    // Don't reveal "this email looks malformed" — same generic response.
    return err({ code: 'invalid-credentials' });
  }

  // 1. Rate limiting (email AND ip)
  const emailLimit = await deps.limiter.check(
    `signin:email:${normalisedEmail}`,
    RATE_LIMIT_PER_EMAIL.max,
    RATE_LIMIT_PER_EMAIL.windowSeconds,
  );
  const ipLimit = await deps.limiter.check(
    `signin:ip:${input.sourceIp}`,
    RATE_LIMIT_PER_IP.max,
    RATE_LIMIT_PER_IP.windowSeconds,
  );
  if (!emailLimit.success || !ipLimit.success) {
    const retryAfter = Math.max(
      Math.ceil((emailLimit.reset - Date.now()) / 1000),
      Math.ceil((ipLimit.reset - Date.now()) / 1000),
      1,
    );
    return err({ code: 'rate-limited', retryAfterSeconds: retryAfter });
  }

  // 2. User lookup
  const found = await deps.users.findByEmail(normalisedEmail);
  const now = deps.now();

  if (!found) {
    // 3a. Unknown email — pay the argon2 cost so timing doesn't leak.
    await deps.hasher.verifyDummy(input.password);
    await deps.audit.append({
      eventType: 'sign_in_failure',
      actorUserId: 'anonymous',
      sourceIp: input.sourceIp,
      summary: `unknown email attempted to sign in`,
      requestId: input.requestId,
    });
    return err({ code: 'invalid-credentials' });
  }

  const { user, passwordHash } = found;

  // 3b. Disabled
  if (user.status === 'disabled') {
    await deps.audit.append({
      eventType: 'sign_in_failure',
      actorUserId: user.id,
      targetUserId: user.id,
      sourceIp: input.sourceIp,
      summary: 'sign-in attempt on disabled account',
      requestId: input.requestId,
    });
    return err({ code: 'account-disabled' });
  }

  // 3c. Pending (never redeemed invitation) — same generic response.
  // (Truthy check on passwordHash avoids tripping the no-restricted-syntax
  // password-equality guard from eslint.config.mjs.)
  if (user.status === 'pending' || !passwordHash) {
    await deps.hasher.verifyDummy(input.password);
    await deps.audit.append({
      eventType: 'sign_in_failure',
      actorUserId: user.id,
      targetUserId: user.id,
      sourceIp: input.sourceIp,
      summary: 'sign-in attempt on pending account',
      requestId: input.requestId,
    });
    return err({ code: 'invalid-credentials' });
  }

  // 4. Lockout check — `isLocked` narrows the type so `lockedUntil` is
  //    `Date`, not `Date | null`. No non-null assertion needed.
  if (isLocked(user, now)) {
    const retryAfter = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000);
    await deps.audit.append({
      eventType: 'sign_in_failure',
      actorUserId: user.id,
      targetUserId: user.id,
      sourceIp: input.sourceIp,
      summary: 'sign-in attempt on locked account',
      requestId: input.requestId,
    });
    return err({ code: 'account-locked', retryAfterSeconds: retryAfter });
  }

  // 5. Verify password
  const passwordOk = await deps.hasher.verify(passwordHash, input.password);

  if (!passwordOk) {
    const newCount = await deps.users.incrementFailedCount(user.id);
    if (newCount >= FAILED_ATTEMPTS_BEFORE_LOCKOUT) {
      const lockUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
      await deps.users.setLocked(user.id, lockUntil);
      await deps.audit.append({
        eventType: 'lockout_triggered',
        actorUserId: user.id,
        targetUserId: user.id,
        sourceIp: input.sourceIp,
        summary: `account locked after ${newCount} failed attempts`,
        requestId: input.requestId,
      });
      authMetrics.lockout();
    }
    await deps.audit.append({
      eventType: 'sign_in_failure',
      actorUserId: user.id,
      targetUserId: user.id,
      sourceIp: input.sourceIp,
      summary: 'wrong password',
      requestId: input.requestId,
    });
    return err({ code: 'invalid-credentials' });
  }

  // 6. Portal mismatch — same generic response (no portal leak)
  if (PORTAL_FOR_ROLE[user.role] !== input.portal) {
    await deps.audit.append({
      eventType: 'sign_in_failure',
      actorUserId: user.id,
      targetUserId: user.id,
      sourceIp: input.sourceIp,
      summary: `portal mismatch — ${user.role} attempted ${input.portal} portal`,
      requestId: input.requestId,
    });
    return err({ code: 'invalid-credentials' });
  }

  // 7. Success path
  await deps.users.clearFailedCount(user.id);
  const session = await deps.sessions.create({
    userId: user.id,
    sourceIp: input.sourceIp,
    now,
  });
  await deps.users.updateLastSignIn(user.id, now);
  await deps.audit.append({
    eventType: 'sign_in_success',
    actorUserId: user.id,
    targetUserId: user.id,
    sourceIp: input.sourceIp,
    summary: `signed in via ${input.portal} portal`,
    requestId: input.requestId,
  });

  logger.info(
    { userIdHash: hashId(user.id), role: user.role, portal: input.portal, requestId: input.requestId },
    'sign_in_success',
  );

  return ok({ session, user });
}

/** Helper exposed so the role-portal validation matches the use case. */
export function expectedPortal(role: Role): Portal {
  return PORTAL_FOR_ROLE[role];
}
