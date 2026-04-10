/**
 * forgot-password use case (T099, spec US3 AS1, FR-005, FR-016).
 *
 * Algorithm:
 *   1. Rate-limit by email (3/h) and by IP (10/h). Exceeded → err(rate-limited).
 *   2. Look up user by email (case-insensitive, same brand path as sign-in).
 *   3. If the user does not exist OR is not `active`: return ok (no-op).
 *      We do NOT emit an audit event in these branches to avoid
 *      log-side enumeration (anyone with audit access could otherwise
 *      confirm whether a given email corresponds to an account).
 *   4. For active users:
 *      - Invalidate any previously-issued unconsumed reset tokens
 *        (spec FR-005: exactly one live reset token per user at a time).
 *      - Create a fresh 64-hex reset token with 1-hour TTL.
 *      - Send the reset email via Resend. On email failure we still
 *        return ok(true) to preserve enumeration safety — the operator
 *        sees the delivery failure in logs.
 *      - Emit `password_reset_requested` audit event.
 *
 * ALWAYS returns 200 at the HTTP layer regardless of the outcome
 * (spec FR-016 "if the email is registered, a link has been sent" is
 * the user-facing copy). The route handler therefore only needs to
 * distinguish ok from rate-limited.
 *
 * Pure Application layer — NO framework imports, NO thrown exceptions
 * across the public boundary. Deps are injectable for contract tests.
 */
import { Result, err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { authMetrics } from '@/lib/metrics';
import { asEmailAddress } from '@/modules/auth/domain/branded';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { TokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import type { EmailSender } from '@/modules/auth/infrastructure/email/resend-client';
import {
  buildResetPasswordEmail,
  type EmailLocale,
} from '@/modules/auth/infrastructure/email/reset-password-email';
import { defaultForgotPasswordDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface ForgotPasswordInput {
  readonly email: string;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly locale?: EmailLocale | undefined;
}

export type ForgotPasswordSuccess = { readonly ok: true };

export type ForgotPasswordError = {
  readonly code: 'rate-limited';
  readonly retryAfterSeconds: number;
};

// --- Tunables ----------------------------------------------------------------

const RATE_LIMIT_PER_EMAIL = { max: 3, windowSeconds: 60 * 60 };
const RATE_LIMIT_PER_IP = { max: 10, windowSeconds: 60 * 60 };

// --- Dependencies ------------------------------------------------------------

export interface ForgotPasswordDeps {
  readonly users: UserRepo;
  readonly tokens: TokenRepo;
  readonly audit: AuditRepo;
  readonly limiter: RateLimiter;
  readonly email: EmailSender;
  readonly now: () => Date;
}

export { defaultForgotPasswordDeps };

// --- Use case ----------------------------------------------------------------

export async function forgotPassword(
  input: ForgotPasswordInput,
  deps: ForgotPasswordDeps = defaultForgotPasswordDeps,
): Promise<Result<ForgotPasswordSuccess, ForgotPasswordError>> {
  // 1. Rate limiting (email + ip)
  const emailLimit = await deps.limiter.check(
    `forgot:email:${input.email.toLowerCase()}`,
    RATE_LIMIT_PER_EMAIL.max,
    RATE_LIMIT_PER_EMAIL.windowSeconds,
  );
  const ipLimit = await deps.limiter.check(
    `forgot:ip:${input.sourceIp}`,
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

  // 2. Parse email (failure = silent ok)
  let normalisedEmail;
  try {
    normalisedEmail = asEmailAddress(input.email);
  } catch {
    return ok({ ok: true });
  }

  // 3. Look up user
  const found = await deps.users.findByEmail(normalisedEmail);
  if (!found) {
    // `email_known=false` — the metric is server-side-only so a raw
    // boolean is safe; the label is never exposed to the client.
    authMetrics.passwordResetRequested(false);
    return ok({ ok: true });
  }

  const { user } = found;
  if (user.status !== 'active') {
    // Pending or disabled — no email sent, no audit event, but still
    // a metric (the attempt is server-side observable).
    authMetrics.passwordResetRequested(false);
    return ok({ ok: true });
  }
  authMetrics.passwordResetRequested(true);

  const now = deps.now();

  // 4. Invalidate existing unconsumed tokens and create a fresh one.
  await deps.tokens.invalidateAllUnconsumedForUser(user.id, now);
  const token = await deps.tokens.createReset({ userId: user.id, now });

  // 5. Send the email. Failure is logged but does NOT change the HTTP
  //    response (enumeration safety).
  const built = buildResetPasswordEmail({
    toEmail: user.email,
    token: token.id,
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
      },
      'forgot_password.email_send_failed',
    );
  }

  // 6. Audit (only for existing active accounts)
  await deps.audit.append({
    eventType: 'password_reset_requested',
    actorUserId: user.id,
    targetUserId: user.id,
    sourceIp: input.sourceIp,
    summary: 'password reset requested',
    requestId: input.requestId,
  });

  return ok({ ok: true });
}
