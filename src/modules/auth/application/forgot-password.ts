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
// `buildResetPasswordEmail` is a PURE template function (no DB, no
// network). The function VALUE is injected via `ForgotPasswordDeps`
// from the composition root (`auth-deps.ts`); the type is
// imported here as a compile-time-only reference. This mirrors the
// `create-user.ts` pattern and keeps the Application layer free of
// concrete Infrastructure module bindings (Constitution Principle III).
import type {
  buildResetPasswordEmail as BuildResetPasswordEmailFn,
  EmailLocale,
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
  readonly buildResetPasswordEmail: typeof BuildResetPasswordEmailFn;
  readonly now: () => Date;
}

export { defaultForgotPasswordDeps };

// --- Use case ----------------------------------------------------------------

export async function forgotPassword(
  input: ForgotPasswordInput,
  deps: ForgotPasswordDeps = defaultForgotPasswordDeps,
): Promise<Result<ForgotPasswordSuccess, ForgotPasswordError>> {
  // 1. Normalise the email FIRST (before rate-limit lookup) so the
  //    rate-limit bucket key matches the same canonical form used by
  //    the user-repo lookup. Without this, an attacker could submit
  //    " user@example.com " (whitespace) and " user@example.com" and
  //    " USER@example.com" as different rate-limit keys while still
  //    hitting the same `users` row — bypassing the per-email bucket.
  //    A parse failure is treated as "ok, silent" to preserve
  //    enumeration safety (FR-005). The IP bucket still applies in
  //    that case so a brute-force probe of malformed addresses can
  //    still be rate-limited.
  let normalisedEmail;
  try {
    normalisedEmail = asEmailAddress(input.email);
  } catch {
    // Parse failure: drain ONE token from the per-IP bucket so a
    // probe-the-form attacker can't bypass IP rate-limit by sending
    // unparseable junk, then return ok (enumeration safety).
    await deps.limiter.check(
      `forgot:ip:${input.sourceIp}`,
      RATE_LIMIT_PER_IP.max,
      RATE_LIMIT_PER_IP.windowSeconds,
    );
    return ok({ ok: true });
  }

  // 2. Rate limiting (email + ip) — use the normalised email so the
  //    bucket key is canonical.
  const emailLimit = await deps.limiter.check(
    `forgot:email:${normalisedEmail}`,
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
  const built = deps.buildResetPasswordEmail({
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
    // B5 — dedicated audit event so the trail records the failure
    // alongside the password_reset_requested row below. Pre-B5 the
    // audit trail read "request issued + presumed email sent" when
    // Resend retries had actually exhausted — operators investigating
    // "I never got the email" had no audit link to the cause.
    await deps.audit.append({
      eventType: 'password_reset_email_failed',
      actorUserId: user.id,
      targetUserId: user.id,
      sourceIp: input.sourceIp,
      summary: `Resend exhausted: ${sendResult.error.code}`,
      requestId: input.requestId,
    });
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
