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
 * Paths that pino MUST redact before writing any log line. Exported
 * so `tests/unit/lib/logger-redaction.test.ts` can import the
 * canonical list — a local copy in tests is prone to drift (the
 * test list has been observed to fall behind the production list).
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
  // P2 Wave-0 — F6 attendee-import logs the lower-cased attendee email as
  // `attendeeEmailLower` (a distinct key the `email`/`*.email` paths do NOT
  // match, since pino redaction is exact-key). Redact it at depths 0–2.
  'attendeeEmailLower',
  '*.attendeeEmailLower',
  '*.*.attendeeEmailLower',
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
  // `*.*.recipient_email` covers depth-2 in case a caller logs
  // `{ event: { payload: { recipient_email } } }` — pino's `*`
  // matches exactly ONE intermediate key.
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
  // --- F8 escalation task free-text PII (Phase 8 R10 W5 close) ---
  // Admin-entered outcome notes (≤1000 chars) and skip reasons
  // (≤500 chars) can contain names, phone numbers, and operational
  // PII captured during follow-up calls. These fields are
  // intentionally persisted in `audit_log.payload` (forensic trail
  // per Constitution Principle VIII + GDPR Art. 17(3)(b) legal
  // obligation), but MUST NOT appear in pino logs at any level.
  // Defence-in-depth: today the use-case catches log only
  // `{ err.message, taskId }` (no free-text), but a future caller
  // accidentally logging the input body or the Task row would leak
  // PII. Redaction here is the final guard. Mirrors the F4
  // payment_reference precedent above.
  'outcomeNote',
  '*.outcomeNote',
  'outcome_note',
  '*.outcome_note',
  'skippedReason',
  '*.skippedReason',
  'skipped_reason',
  '*.skipped_reason',
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
  // HTTP header casing variants. Node normalises incoming headers
  // to lowercase but a caller who logs a custom Headers object or
  // upper-cases a key during manipulation could hit either shape.
  'STRIPE-SIGNATURE',
  '*.STRIPE-SIGNATURE',
  'StripeSignature',
  '*.StripeSignature',
  // Defence-in-depth for the F5 gateway error `reason` field. The
  // route handler explicitly logs only the bounded
  // `processorErrorKind` discriminator, but if a caller,
  // middleware, or error boundary ever serialises the gateway
  // error directly into a pino object, redaction here prevents
  // the raw Stripe SDK message (which may carry account ids /
  // key prefixes / forbidden detail) from reaching the log sink.
  // Coverage matrix — every observable serialization shape:
  //   - `{processorReason: ...}`              (route-side camelCase)
  //   - `{reason: ...}`                       (top-level spread of gateway error)
  //   - `{error: {reason: ...}}`              (gateway error nested under `error`)
  //   - `{result: {error: {reason: ...}}}`    (full Result<T,E> envelope)
  //   - `{<anyKey>: {error: {reason: ...}}}`  (depth-2 wildcard)
  // R2 F-02 (2026-04-27 security review): the bare `reason` and
  // `*.reason` paths are intentionally broad. The reviewer suggested
  // narrowing them, but the existing logger-redact.test.ts asserts
  // that top-level `reason: 'sk_live_FORBIDDEN_DETAIL'` IS redacted
  // (Stripe SDK errors spread into the log without nesting in some
  // call paths). Erring on the side of over-redaction is correct for
  // a PCI SAQ-A-scoped logger. Operational `reason` fields that are
  // genuinely safe to display should be renamed to a non-`reason` key
  // (e.g. `dispatchFailureKind` already used in the webhook route).
  'processorReason',
  '*.processorReason',
  'reason',
  '*.reason',
  'error.reason',
  '*.error.reason',
  'result.error.reason',
  '*.result.error.reason',
  // Round 6 W-R5-1 — F8 mark-paid-offline route logs F4 internal
  // `reason` under the `f4Reason` key to disambiguate from the result
  // envelope's own `reason`. Path-based redaction follows the field
  // name verbatim, so bare `reason` paths above do NOT catch
  // `f4Reason`. F4 internals (schema names, column names, row
  // fragments) MUST never reach Sentry / Grafana.
  'f4Reason',
  '*.f4Reason',
  // Round 7 W-R6-4 — `f4Stage` is a closed enum of F4 use-case
  // identifiers (`'create_invoice_failed'` / `'issue_invoice_failed'`
  // / `'record_payment_failed'`) that embed internal operation names.
  // Lower sensitivity than `f4Reason` but still schema-leaking;
  // belt-and-suspenders redaction so a future F4 stage rename that
  // reveals an internal column or path name does not silently leak.
  'f4Stage',
  '*.f4Stage',
  // review-20260428-102639.md S1 closure — defense-in-depth: F4 + F5
  // worker / cron paths carry `memberIdentitySnapshot` (member name +
  // address + email PII) in scan rows. Never logged today, but path-
  // based redaction means a future contributor logging the row
  // accidentally cannot leak PII.
  'memberIdentitySnapshot',
  '*.memberIdentitySnapshot',
  'member_identity_snapshot',
  '*.member_identity_snapshot',
  // --- F7 broadcasts secrets + content + signature headers (T175,
  // FR-042; plan.md § 22.4 redact rules) ---
  // Resend Broadcasts secrets — separate from F1+F4 transactional
  // RESEND_API_KEY (already redacted above). Compromise grants the
  // ability to dispatch arbitrary broadcasts on tenant accounts.
  'RESEND_BROADCASTS_API_KEY',
  'resend_broadcasts_api_key',
  '*.resend_broadcasts_api_key',
  'resendBroadcastsApiKey',
  '*.resendBroadcastsApiKey',
  'RESEND_BROADCASTS_WEBHOOK_SECRET',
  'resend_broadcasts_webhook_secret',
  '*.resend_broadcasts_webhook_secret',
  'resendBroadcastsWebhookSecret',
  '*.resendBroadcastsWebhookSecret',
  // F7 unsubscribe-token HMAC secret. Independent rotation cadence
  // from AUTH_COOKIE_SIGNING_SECRET per research.md § 4.
  'UNSUBSCRIBE_TOKEN_SECRET',
  'unsubscribe_token_secret',
  '*.unsubscribe_token_secret',
  'unsubscribeTokenSecret',
  '*.unsubscribeTokenSecret',
  // Svix HMAC headers on the Resend Broadcasts webhook. Mirror the
  // Stripe-Signature redaction above.
  'Svix-Signature',
  '*.Svix-Signature',
  'svix-signature',
  '*.svix-signature',
  'svixSignature',
  '*.svixSignature',
  'Svix-Id',
  '*.Svix-Id',
  'svix-id',
  '*.svix-id',
  'svixId',
  '*.svixId',
  'Svix-Timestamp',
  '*.Svix-Timestamp',
  'svix-timestamp',
  '*.svix-timestamp',
  'svixTimestamp',
  '*.svixTimestamp',
  'Resend-Signature',
  '*.Resend-Signature',
  'resend-signature',
  '*.resend-signature',
  'resendSignature',
  '*.resendSignature',
  // Member-authored broadcast content. body_html is sanitised at
  // Application boundary but raw HTML never reaches log sinks.
  // Per FR-042 broadcast events log broadcast_id + counts only.
  // R6 staff-review B3 fix — added `*.*.body_html` depth-2 to cover
  // the `audit.payload.body_html` audit-emit shape that legitimately
  // could be produced by `logger.info(auditEvent, ...)`.
  'body_html',
  '*.body_html',
  '*.*.body_html',
  'bodyHtml',
  '*.bodyHtml',
  '*.*.bodyHtml',
  // T199 M-1 — `body_source` carries the raw Tiptap editor content
  // PRE-sanitisation. If a caller logs the full Broadcast domain
  // object, body_source would leak unsanitised HTML / member content.
  'body_source',
  '*.body_source',
  'bodySource',
  '*.bodySource',
  'rejection_reason',
  '*.rejection_reason',
  'rejectionReason',
  '*.rejectionReason',
  // Recipient-list shapes. `recipient_email` (singular) is already
  // redacted above. F7 adds the plural array shape + resolved
  // recipients produced by segment-resolve.
  // R6 staff-review B3 fix — depth-2 patterns added to cover
  // `audit.payload.recipient_emails` shape produced by F7 audit emit.
  'recipient_emails',
  '*.recipient_emails',
  '*.*.recipient_emails',
  'recipientEmails',
  '*.recipientEmails',
  '*.*.recipientEmails',
  'recipient_email_lower',
  '*.recipient_email_lower',
  '*.*.recipient_email_lower',
  'recipientEmailLower',
  '*.recipientEmailLower',
  '*.*.recipientEmailLower',
  'custom_recipient_emails',
  '*.custom_recipient_emails',
  '*.*.custom_recipient_emails',
  'customRecipientEmails',
  '*.customRecipientEmails',
  '*.*.customRecipientEmails',
  // Unsubscribe token plaintext. We log sha256(token) on audit emit.
  'unsubscribe_token',
  '*.unsubscribe_token',
  'unsubscribeToken',
  '*.unsubscribeToken',
  // Round 3 security review T-F7-07 — `tokenPlaintext` is the exact
  // field name on `UnsubscribeRecipientInput`. Without this entry, a
  // future contributor logging the input struct (e.g. `logger.error(input,
  // ...)`) would leak the raw HMAC-signed token. Tokens have no expiry
  // (FR-030 / GDPR Art. 21) so a single leak grants permanent
  // suppression-trigger ability for that recipient.
  'tokenPlaintext',
  '*.tokenPlaintext',
  // --- F8 renewals secrets + tokens + member contact PII (K2 / FR-049)
  // ---
  // F8 spec FR-049 explicitly lists 7 forbidden-in-logs paths. Most are
  // already covered above by F3/F4/F7 wildcards (email,
  // memberLegalNameSnapshot, payment_reference) but the F8-specific
  // tokens + the env-var name + the explicit nested member shape need
  // dedicated entries so a future contributor can grep for FR-049 keys
  // and find them in this file.
  //
  // `member.email` and `member.primary_contact_email` — pino path
  // wildcards `*.email` already redact `{member: {email}}`, but the
  // explicit nested-key form makes the spec-mandated path traceable.
  // We list both forms (snake + camel) of `primary_contact_email`
  // since members module uses camelCase + audit payloads use snake_case.
  'primary_contact_email',
  '*.primary_contact_email',
  '*.*.primary_contact_email',
  'primaryContactEmail',
  '*.primaryContactEmail',
  '*.*.primaryContactEmail',
  // Renewal link tokens — the HMAC-signed self-service deep link token
  // (research.md § 4 + renewal-link-token/hmac-signer.ts). Plaintext
  // token MUST never reach logs; we log sha256(token) + the verified
  // claims when forensic correlation is needed. Both raw + verified
  // shapes appear in code paths today.
  'renewal_token',
  '*.renewal_token',
  '*.*.renewal_token',
  'renewalToken',
  '*.renewalToken',
  '*.*.renewalToken',
  'renewal_link',
  '*.renewal_link',
  '*.*.renewal_link',
  'renewalLink',
  '*.renewalLink',
  '*.*.renewalLink',
  // F8 renewal-link HMAC secret env var (separate rotation cadence
  // from F1 AUTH_COOKIE_SIGNING_SECRET + F7 UNSUBSCRIBE_TOKEN_SECRET).
  // If this ever appears in a log object it's a programming bug; mask
  // it before exfiltration.
  'RENEWAL_LINK_TOKEN_SECRET',
  'renewal_link_token_secret',
  '*.renewal_link_token_secret',
  'renewalLinkTokenSecret',
  '*.renewalLinkTokenSecret',
  // F8 mark-paid-offline + future Stripe-shaped payment method
  // payloads. The bare F8 audit `payment_method` value is a closed enum
  // ('bank_transfer' | 'cash' | 'cheque') which is non-sensitive — but
  // FR-049 lists `payment_method` defensively because a future caller
  // serialising a Stripe PaymentMethod object (with embedded card
  // metadata: brand/last4/exp_month/exp_year) into a log under this key
  // would silently leak PCI-adjacent data. Erring on over-redaction is
  // correct for SAQ-A scope.
  'payment_method',
  '*.payment_method',
  '*.*.payment_method',
  'paymentMethod',
  '*.paymentMethod',
  '*.*.paymentMethod',
  // --- F6 EventCreate Integration secrets + headers + PII (T002, plan.md
  // § Observability + FR-002) ---
  // Per-tenant webhook signing secrets stored in `tenant_webhook_configs`.
  // The `active` secret is the current HMAC key Zapier uses to sign
  // deliveries; the `grace` secret is the previous key still accepted for
  // 24h after rotation per FR-008 / R7. Either is a complete capability
  // to forge a valid signed payload — never logged at any level.
  'webhook_secret_active',
  '*.webhook_secret_active',
  '*.*.webhook_secret_active',
  'webhookSecretActive',
  '*.webhookSecretActive',
  '*.*.webhookSecretActive',
  'webhook_secret_grace',
  '*.webhook_secret_grace',
  '*.*.webhook_secret_grace',
  'webhookSecretGrace',
  '*.webhookSecretGrace',
  '*.*.webhookSecretGrace',
  // Custom HMAC signature header on F6 webhook receiver — mirror of the
  // Stripe-Signature / Svix-Signature precedent above. Logging it would
  // let an attacker replay legitimate Zapier deliveries with a valid
  // signature. Header casing variants: Node normalises incoming headers
  // to lowercase, but a caller logging a custom Headers object or
  // upper-casing during manipulation could hit either shape.
  'X-Chamber-Signature',
  '*.X-Chamber-Signature',
  'x-chamber-signature',
  '*.x-chamber-signature',
  'X-CHAMBER-SIGNATURE',
  '*.X-CHAMBER-SIGNATURE',
  'XChamberSignature',
  '*.XChamberSignature',
  'xChamberSignature',
  '*.xChamberSignature',
  // Companion timestamp header used for 5-min skew enforcement (R2).
  // Less sensitive than the signature value itself but still part of the
  // verification envelope; redacting defence-in-depth.
  'X-Chamber-Timestamp',
  '*.X-Chamber-Timestamp',
  'x-chamber-timestamp',
  '*.x-chamber-timestamp',
  // Attendee email — already covered by the generic `email` / `*.email`
  // redaction above, but the explicit F6 audit-replay path emits payloads
  // shaped `{attendee: {email}}` and `{attendee_email: ...}` that benefit
  // from a verbatim entry so a future contributor grepping for
  // `attendee_email` in the redact list can find it. Both snake-case
  // (audit payload shape) + camelCase (Domain VO shape) variants. Depth-2
  // covers `{audit: {payload: {attendee_email}}}` as a F7 precedent.
  'attendee_email',
  '*.attendee_email',
  '*.*.attendee_email',
  'attendeeEmail',
  '*.attendeeEmail',
  '*.*.attendeeEmail',
  // R6-S20 staff-review fix (2026-05-13, PDPA M-6): attendee name +
  // company are PII under PDPA/GDPR. The audit-replay path emits
  // `webhook_rolled_back` and `webhook_signature_rejected` payloads
  // that may include `attendee_name` / `attendee_company` if a future
  // audit shape extension lands. Add explicit redact paths now so any
  // future emit is suppressed by default. Both snake-case + camelCase
  // depth-2 — same pattern as attendee_email above.
  'attendee_name',
  '*.attendee_name',
  '*.*.attendee_name',
  'attendeeName',
  '*.attendeeName',
  '*.*.attendeeName',
  'attendee_company',
  '*.attendee_company',
  '*.*.attendee_company',
  'attendeeCompany',
  '*.attendeeCompany',
  '*.*.attendeeCompany',
  // F6 deterministic pseudonymisation salt — env var name + camelCase
  // accessor shape on `env.eventcreate.piiPseudonymSalt`. A leak would
  // let an attacker pre-compute pseudonyms for non-member registrations
  // and de-anonymise the retention-purged history. SECRET — masked
  // before any log line is emitted.
  'EVENTCREATE_PII_PSEUDONYM_SALT',
  'eventcreate_pii_pseudonym_salt',
  '*.eventcreate_pii_pseudonym_salt',
  'piiPseudonymSalt',
  '*.piiPseudonymSalt',
  'pii_pseudonym_salt',
  '*.pii_pseudonym_salt',
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
