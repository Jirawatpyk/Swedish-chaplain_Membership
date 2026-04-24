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
  // --- F5 payment PCI / Stripe secrets (T032, security.md § 6) ---
  // Under PCI DSS SAQ-A, cardholder data (PAN, CVV, track) MUST NEVER
  // touch the Chamber-OS server. If Stripe.js ever leaks these into a
  // payload + a caller logs the payload, redaction here is the final
  // line of defence. The `card` wildcard covers the shape returned by
  // Stripe.js (`{card: {number, cvc, exp_month, exp_year}}`) where the
  // whole sub-object is redacted en bloc — safer than trying to
  // enumerate every field variant.
  'card_number',
  '*.card_number',
  'cardNumber',
  '*.cardNumber',
  'card_cvc',
  '*.card_cvc',
  'cardCvc',
  '*.cardCvc',
  // PCI guardian Finding 2 — CVV variants emitted by browsers / older
  // Stripe.js / issuer-facing APIs / Stripe webhook bodies. Logging
  // these is a PCI Req 3.2.1 violation.
  'cvv',
  '*.cvv',
  'cvv2',
  '*.cvv2',
  'csc',
  '*.csc',
  'cid',
  '*.cid',
  'security_code',
  '*.security_code',
  'card_security_code',
  '*.card_security_code',
  'cvc_check',
  '*.cvc_check',
  '*.*.cvc_check',
  'card',
  '*.card',
  'card.*',
  '*.card.*',
  // Group E1 (2026-04-24) — `client_secret` is the single most
  // dangerous PCI-adjacent value Stripe returns: it authorises a
  // browser to confirm a PaymentIntent. Redact both camelCase
  // (port-shape) and snake_case (raw Stripe SDK response shape).
  'clientSecret',
  '*.clientSecret',
  'client_secret',
  '*.client_secret',
  // Card-network metadata that can enable fingerprint-linking of
  // cardholders across tenants (PCI DSS Req 3.2). `card.*` already
  // catches nested values, but Stripe sometimes returns these as
  // top-level keys on charge / payment_method_details shapes.
  'fingerprint',
  '*.fingerprint',
  'iin',
  '*.iin',
  // Stripe's `payment_method_details.card.*` shape from Charge
  // objects. Covers `brand`, `last4`, `exp_month`, `exp_year`,
  // `fingerprint`, `network` — any nested field under this sub-
  // object is redacted en bloc.
  'payment_method_details',
  '*.payment_method_details',
  'payment_method_details.card',
  '*.payment_method_details.card',
  'payment_method_details.card.*',
  '*.payment_method_details.card.*',
  'paymentMethodDetails',
  '*.paymentMethodDetails',
  // Raw webhook request body — contains the entire Stripe event
  // payload (card metadata, clientSecret on some event types, PII).
  // Callers needing to forensically inspect a webhook body should
  // use the `processor_events.payload_sha256` column + Stripe
  // Dashboard, not a log dump.
  'rawBody',
  '*.rawBody',
  'raw_body',
  '*.raw_body',
  // Stripe secrets — these live in env vars per Constitution Principle
  // IV; if they ever appear in a log object it's a bug worth redacting.
  'stripe_secret_key',
  '*.stripe_secret_key',
  'stripeSecretKey',
  '*.stripeSecretKey',
  'STRIPE_SECRET_KEY',
  'stripe_webhook_secret',
  '*.stripe_webhook_secret',
  'stripeWebhookSecret',
  '*.stripeWebhookSecret',
  'STRIPE_WEBHOOK_SECRET',
  // Stripe-Signature header — carries an HMAC proving the webhook was
  // Stripe-issued. Logging it would let an attacker replay events with
  // a valid signature. Redact both the hyphenated HTTP casing and the
  // camelCase object-property variant.
  'Stripe-Signature',
  '*.Stripe-Signature',
  'stripe-signature',
  '*.stripe-signature',
  'stripeSignature',
  '*.stripeSignature',
  // PCI guardian R3 — HTTP header casing variants. Node normalises
  // incoming headers to lowercase but a caller who logs a custom
  // Headers object or upper-cases a key during manipulation could
  // hit either of these shapes.
  'STRIPE-SIGNATURE',
  '*.STRIPE-SIGNATURE',
  'StripeSignature',
  '*.StripeSignature',
];

/**
 * F5 / T032 — defence-in-depth PAN (Primary Account Number) value-
 * pattern redaction. Path-based `REDACT_PATHS` only fires when the
 * caller uses the expected field name; a caller that logs an entire
 * Stripe event body or a free-form note CAN still surface a bare PAN.
 *
 * Pattern covers (ranges + length gates — pci-saqa-guardian Finding 1
 * + R1 remediation):
 *   - `3[47]\d{13}`      — Amex (15 digits)
 *   - `4\d{12,18}`       — Visa (13 / 16 / 19 digits)
 *   - `5[1-5]\d{14}`     — MasterCard legacy (16 digits)
 *   - `2[2-7]\d{14}`     — MasterCard 2-series (16 digits)
 *   - `6011\d{12,15}`    — Discover (16 / 19 digits)
 *   - `65\d{14}`         — Discover prefix-65 (16 digits)
 *   - `62\d{14,17}`      — UnionPay (16 / 19 digits) — Thai market relevance
 *   - `35\d{14,17}`      — JCB (16 / 19 digits)
 *   - `36\d{12}`         — Diners (14 digits)
 *
 * Anchored ^/$ so English prose ("error: 4242… declined") is NOT
 * redacted based on substring matches. Callers that log prose with
 * an embedded PAN are responsible for their own field hygiene.
 */
export const PAN_REGEX =
  /^(?:3[47]\d{13}|4\d{12}(?:\d{3}|\d{6})?|5[1-5]\d{14}|2[2-7]\d{14}|6011\d{12}(?:\d{3})?|65\d{14}|62\d{14}(?:\d{3})?|35\d{14}(?:\d{3})?|36\d{12})$/;

/**
 * Pattern for normalising pretty-printed PANs before testing. A PAN
 * with spaces or hyphens (`"4242 4242 4242 4242"`, `"4242-4242-..."`)
 * would evade the anchored digit-only regex without this step. We
 * normalise ONLY if the raw value matches a conservative
 * "digits-and-separators-of-PAN-shape" gate (short, 12-23 chars,
 * digits+spaces+hyphens only) so we don't strip delimiters from
 * unrelated strings.
 */
const PAN_PRETTY_SHAPE = /^\d[\d\s-]{11,22}\d$/;

function normaliseForPanTest(input: string): string {
  if (!PAN_PRETTY_SHAPE.test(input)) return input;
  return input.replace(/[\s-]/g, '');
}

/**
 * Recursively replaces any string value matching `PAN_REGEX` (after
 * space/hyphen normalisation) with `[REDACTED]`. Object-valued inputs
 * are cloned depth-first so the caller's original log object is NEVER
 * mutated (pino's `formatters.log` hook docs require callers avoid
 * mutating input). Depth-bounded at 9 levels (audit payloads nest at
 * most 4; 9 is generous + cycle-safe).
 */
export function redactPanValues(input: unknown, depth = 0): unknown {
  if (depth > 9) return input;
  if (typeof input === 'string') {
    const normalised = normaliseForPanTest(input);
    return PAN_REGEX.test(normalised) ? '[REDACTED]' : input;
  }
  if (Array.isArray(input)) {
    return input.map((v) => redactPanValues(v, depth + 1));
  }
  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = redactPanValues(v, depth + 1);
    }
    return out;
  }
  return input;
}

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
    // T032 — final pass to redact bare PAN values that the path-based
    // `REDACT_PATHS` above cannot catch (e.g. a PAN appearing inside a
    // free-form `message` string or an unexpected field name). Runs
    // after pino's own redaction step, so `[REDACTED]` bindings are
    // already in place; this only reaches real string values.
    log(object) {
      return redactPanValues(object) as Record<string, unknown>;
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
