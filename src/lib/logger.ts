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

const REDACT_PATHS = [
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

const transport: LoggerOptions['transport'] = env.isDevelopment
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
