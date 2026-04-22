/**
 * Transactional email sender (T038, research.md § 6.1).
 *
 * Wraps Resend with:
 *   - 3-retry exponential backoff (1 s / 2 s / 4 s)
 *   - Structured logging with redacted recipient
 *   - Result-typed return so the Application layer never deals with
 *     thrown exceptions across the boundary
 *
 * Templates live in `src/modules/auth/infrastructure/email/*.tsx`
 * (reset-password: T098, invitation: T122).
 */
import { Resend } from 'resend';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { type Result, err, ok } from '@/lib/result';

const resend = new Resend(env.resend.apiKey);

/**
 * Default sender address. Resolution order:
 *   1. `RESEND_FROM_EMAIL` env var (set in Vercel + .env.local once
 *      the target domain has been verified in the Resend dashboard).
 *   2. Hardcoded `SweCham <noreply@zyncdata.app>` fallback — the
 *      verified Resend domain for current deployments. If the fallback
 *      is used in an environment where `zyncdata.app` is NOT verified
 *      in Resend, Resend will reject the send with HTTP 403 "This API
 *      key is not authorized to send emails from zyncdata.app", which
 *      the retry loop logs and the Application layer tolerates
 *      (invitations are still created; the admin can resend from the
 *      UI once the env var is set).
 */
const FALLBACK_FROM = 'SweCham <noreply@zyncdata.app>';
const DEFAULT_FROM = env.resend.fromEmail ?? FALLBACK_FROM;

/**
 * F4 FR-036 — file attachment for cancellation emails (VOID-stamped
 * invoice PDF). `content` is raw bytes; the sender encodes for
 * Resend's `attachments[]` API. Callers who only need a download link
 * should continue to build link-based HTML bodies and omit this field.
 */
export interface EmailAttachment {
  readonly filename: string;
  readonly content: Uint8Array;
  readonly contentType: string;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly /** Pre-rendered HTML body (use @react-email to build). */ html: string;
  readonly /** Plain-text fallback for clients that prefer it. */ text?: string;
  readonly from?: string;
  /** FR-036 — optional file attachments (currently only invoice_voided uses this). */
  readonly attachments?: readonly EmailAttachment[];
}

export type EmailError =
  | { readonly code: 'invalid-recipient'; readonly message: string }
  | { readonly code: 'upstream-unavailable'; readonly message: string }
  | { readonly code: 'unknown'; readonly message: string };

export interface EmailSender {
  send(message: EmailMessage): Promise<Result<{ messageId: string }, EmailError>>;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class ResendEmailSender implements EmailSender {
  async send(
    message: EmailMessage,
  ): Promise<Result<{ messageId: string }, EmailError>> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await resend.emails.send({
          from: message.from ?? DEFAULT_FROM,
          to: message.to,
          subject: message.subject,
          html: message.html,
          ...(message.text ? { text: message.text } : {}),
          // FR-036 — Resend accepts `attachments[]` with either
          // base64-string `content` or a URL. We pass raw bytes via
          // Buffer so the sender does not need to know the storage
          // layer.
          ...(message.attachments && message.attachments.length > 0
            ? {
                attachments: message.attachments.map((a) => ({
                  filename: a.filename,
                  content: Buffer.from(a.content),
                  contentType: a.contentType,
                })),
              }
            : {}),
        });

        if (response.error) {
          lastError = response.error;
          // Resend returns structured error codes — only retry on
          // transient ones (5xx, network) and bail immediately on
          // permanent ones (invalid recipient, unauthorized).
          const code = (response.error as { name?: string }).name ?? 'unknown';
          if (code === 'validation_error' || code === 'invalid_to_address') {
            return err({
              code: 'invalid-recipient',
              message: response.error.message,
            });
          }
          // Fall through to retry / failure handling below.
        } else if (response.data?.id) {
          if (attempt > 0) {
            logger.info(
              { messageId: response.data.id, attempt },
              'email sent after retry',
            );
          }
          return ok({ messageId: response.data.id });
        }
      } catch (error) {
        lastError = error;
        logger.warn({ err: error, attempt }, 'resend send failed, will retry');
      }

      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs !== undefined) {
        await delay(delayMs);
      }
    }

    logger.error(
      { err: lastError },
      'resend send failed after exhausting retries',
    );
    return err({
      code: 'upstream-unavailable',
      message: 'Resend send failed after 3 retries',
    });
  }
}

export const emailSender: EmailSender = new ResendEmailSender();
