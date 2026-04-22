import { isMainThread } from 'worker_threads';
import pino, { type LoggerOptions } from 'pino';
import { env } from './env';

/**
 * Structured JSON logger (T018, docs/observability.md § 3).
 *
 * Output schema (one JSON object per line):
 *   {
 *     "level": 30,
 *     "time": 1712664000000,
 *     "msg": "sign-in success",
 *     "service": "swecham-membership",
 *     "env": "production",
 *     "requestId": "01HV…",
 *     "userIdHash": "abc123",     // never the raw id
 *     "authEvent": "sign_in_success",
 *     "outcome": "ok"
 *   }
 *
 * Forbidden fields (auto-redacted) per CLAUDE.md § Secrets and
 * security.md T-14:
 *   - password*
 *   - token*
 *   - secret*
 *   - authorization
 *   - cookie
 *   - sessionId / session_id
 *
 * The redaction is shallow (covers top-level + one level deep) — use
 * dot-separated paths to redact nested fields.
 */

/**
 * Paths that pino MUST redact before writing any log line. Exported so
 * `tests/unit/lib/logger-redaction.test.ts` can import the canonical
 * list (instead of maintaining a stale copy-paste) — R3 review found
 * the previous local copy had drifted to omit 22 paths.
 *
 * Pino's `*` wildcard matches exactly ONE intermediate key. Use
 * `*.field` for depth-1 and `*.*.field` for depth-2 when a field
 * classified as sensitive can legitimately appear in a nested payload
 * (e.g. audit events carrying `recipient_email` two levels deep).
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'newPassword',
  '*.newPassword',
  'currentPassword',
  '*.currentPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'sessionToken',
  '*.sessionToken',
  'resetToken',
  '*.resetToken',
  'invitationToken',
  '*.invitationToken',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'Authorization',
  '*.Authorization',
  'cookie',
  '*.cookie',
  'Cookie',
  '*.Cookie',
  'sessionId',
  '*.sessionId',
  'session_id',
  '*.session_id',
  'AUTH_COOKIE_SIGNING_SECRET',
  'RESEND_API_KEY',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
  // --- F3 member + contact PII (T038, plan § Observability) ---
  // Never log raw contact details — they are collected under
  // PDPA + GDPR lawful basis and log retention exceeds the data-minimization
  // window. Tests assert redaction via `tests/unit/lib/logger-pii.test.ts`.
  'email',
  '*.email',
  'toEmail',
  '*.toEmail',
  'phone',
  '*.phone',
  'date_of_birth',
  '*.date_of_birth',
  'dateOfBirth',
  '*.dateOfBirth',
  'tax_id',
  '*.tax_id',
  'taxId',
  '*.taxId',
  // --- F4 invoicing PII + secrets (T005, plan § Observability) ---
  // Never log raw member-identity snapshots copied onto tax documents,
  // signed-URL tokens that grant 60s access to private PDFs, or raw
  // PDF bytes themselves (huge + contains PII). Tests assert redaction
  // via `tests/unit/lib/logger-pii.test.ts`.
  'member_legal_name_snapshot',
  '*.member_legal_name_snapshot',
  'memberLegalNameSnapshot',
  '*.memberLegalNameSnapshot',
  'member_address_snapshot',
  '*.member_address_snapshot',
  'memberAddressSnapshot',
  '*.memberAddressSnapshot',
  'signed_url_token',
  '*.signed_url_token',
  'signedUrlToken',
  '*.signedUrlToken',
  'pdf_binary',
  '*.pdf_binary',
  'pdfBinary',
  '*.pdfBinary',
  'BLOB_READ_WRITE_TOKEN',
  'CRON_SECRET',
  // R2-I1 (2026-04-22) — F4 audit payloads carry `recipient_email` in
  // both top-level and nested contexts (see security.md § 4 PDPA/GDPR
  // Cat-B classification). Never leak this to logs even if a caller
  // accidentally passes the full audit event object to `logger.info`.
  // `*.*.recipient_email` (R3 hardening) covers depth-2 in case a
  // future caller logs `{ event: { payload: { recipient_email } } }`
  // — pino's `*` matches exactly ONE intermediate key.
  'recipient_email',
  '*.recipient_email',
  '*.*.recipient_email',
  // R19 / QA TC-05 — free-text admin-entered payment reference on
  // F4 `record-payment`. Stored raw on the invoices row (short-term
  // operational lookup under tenant scope); the audit payload already
  // stores a sha256 hash rather than plaintext. This redaction is
  // defence-in-depth so a future caller that accidentally logs the
  // request body or the raw Invoice row doesn't leak partial bank-
  // account numbers / cheque numbers that can appear as free text.
  'payment_reference',
  '*.payment_reference',
  'paymentReference',
  '*.paymentReference',
];

const baseOptions: LoggerOptions = {
  level: env.log.level,
  base: {
    service: 'swecham-membership',
    env: env.nodeEnv,
  },
  // Use unix-millis time so log aggregators index numerically.
  timestamp: pino.stdTimeFunctions.epochTime,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
    remove: false,
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
};

// pino-pretty spawns its own worker thread; skip it when we are already
// inside a worker (e.g. Next.js generateStaticParams / Turbopack workers)
// to avoid ERR_WORKER_INIT_FAILED on Windows.
const transport: LoggerOptions['transport'] = (env.isDevelopment && isMainThread)
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        singleLine: false,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    }
  : undefined;

export const logger = pino({
  ...baseOptions,
  ...(transport ? { transport } : {}),
});

/**
 * Create a child logger with bound context (e.g., requestId, userIdHash).
 * Prefer this over passing context to every `logger.*` call so that the
 * bound fields land in every line of a request's log trail.
 */
export function loggerFor(context: Record<string, unknown>) {
  return logger.child(context);
}
