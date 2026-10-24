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
 *   4. For active users, schedule ONE task via `deps.defer` and return ok.
 *      The route wires next/server `after`, so the task runs AFTER the
 *      response (125 — a registered address does no awaited work an
 *      unknown one skips; FR-016 timing). The task:
 *      - Invalidates any previously-issued unconsumed reset tokens
 *        (spec FR-005: exactly one live reset token per user at a time)
 *        and creates a fresh 64-hex reset token with 1-hour TTL (one tx).
 *      - Sends the reset email via Resend. A delivery failure is logged
 *        and audited (`password_reset_email_failed`).
 *      - Emits the `password_reset_requested` audit event.
 *      Any throw inside the task (token tx included) is logged as
 *      `forgot_password.deferred_failed` — there is no caller to surface
 *      it to once the response has gone. "I never got the email": look
 *      for that log line or `password_reset_email_failed`.
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
import { errKind } from '@/lib/log-id';
import { authMetrics } from '@/lib/metrics';
// Owner-role tx for the atomic stale-invalidate + fresh-token insert (P2
// Wave-0). Same Path-C rationale as create-user.ts: password_reset_tokens is a
// global (cross-tenant) F1 table written under BYPASSRLS, not a tenant-scoped
// runInTenant write.
import { db } from '@/lib/db';
import { asEmailAddress } from '@/modules/auth/domain/branded';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { TokenRepo } from '@/modules/auth/infrastructure/db/token-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { retryAfterSeconds } from '@/modules/auth/application/rate-limit-retry';
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
  /**
   * 125 — schedules the active-user work (token tx + email + audit). The
   * default (auth-deps) runs it inline and awaits it (scripts, tests); the
   * route overrides it with next/server `after` so it runs post-response.
   */
  readonly defer: (task: () => Promise<void>) => void | Promise<void>;
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
    return err({
      code: 'rate-limited',
      retryAfterSeconds: retryAfterSeconds(emailLimit, ipLimit),
    });
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

  // 4–6. Token tx + email + audit run through `deps.defer` (125): awaited
  //      inline, even the token tx alone made a registered address
  //      measurably slower than an unknown one. A throw inside the task has
  //      no caller once the response is gone, so it is logged.
  const deliver = async (): Promise<void> => {
    try {
      const now = deps.now();

      // 4. Invalidate existing unconsumed tokens and create a fresh one —
      //    ATOMICALLY (P2 Wave-0). The invalidate + insert run in ONE
      //    owner-role tx so a crash between them can't strand the user with
      //    every prior token invalidated and none created (no live reset link
      //    AND no email). Email send + audit stay POST-commit below — a
      //    transient send/audit failure must never roll back the token.
      //    E2 — `createResetInTx` returns `{ plaintext, token }`. The
      //    plaintext is delivered in the email URL; the persisted row stores
      //    `sha256(plaintext)` as id.
      const { plaintext } = await db.transaction(async (tx) => {
        await deps.tokens.invalidateAllUnconsumedForUserInTx(tx, user.id, now);
        return deps.tokens.createResetInTx(tx, { userId: user.id, now });
      });

      // 5. Send the email. Failure is logged but does NOT change the
      //    HTTP response (enumeration safety).
      const built = deps.buildResetPasswordEmail({
        toEmail: user.email,
        token: plaintext,
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
    } catch (e) {
      logger.error(
        { err: errKind(e), requestId: input.requestId },
        'forgot_password.deferred_failed',
      );
    }
  };
  await deps.defer(deliver);

  return ok({ ok: true });
}
