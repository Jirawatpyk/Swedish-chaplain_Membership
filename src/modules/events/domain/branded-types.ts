/**
 * T019 — F6 branded ID types.
 *
 * Branded `string` aliases for the IDs that flow through the F6 surface.
 * Branding is Constitution Principle I clause 1 enforcement: forgetting
 * to pass an ID at a call site becomes a compile-time error rather than
 * a runtime mis-match.
 *
 * The `__brand` symbol-string pattern matches the verbatim shape from
 * data-model.md § 5. Smart constructors (`asX`, `tryX`) gate the
 * boundary so untrusted strings (Drizzle row values, HTTP body fields,
 * CSV cells) cannot drift into Domain functions without an explicit
 * narrowing step.
 *
 * Cross-module branded types (`TenantId`, `MemberId`, `ContactId`, `UserId`)
 * are re-exported from `@/modules/members` + `@/modules/auth` barrels —
 * F6 imports them at use sites rather than re-declaring them here.
 *
 * Pure TypeScript — Constitution Principle III.
 */

// --- Branded type declarations ---------------------------------------------

export type EventId = string & { readonly __brand: 'EventId' };
export type RegistrationId = string & {
  readonly __brand: 'RegistrationId';
};
export type ExternalEventId = string & {
  readonly __brand: 'ExternalEventId';
};
export type ExternalAttendeeId = string & {
  readonly __brand: 'ExternalAttendeeId';
};
export type AttendeeEmail = string & { readonly __brand: 'AttendeeEmail' };
export type WebhookSecret = string & { readonly __brand: 'WebhookSecret' };
export type RequestId = string & { readonly __brand: 'RequestId' };

// --- Smart constructors ----------------------------------------------------

/**
 * Branded-type smart constructors — keep validation centralised so callers
 * never construct invalid branded values. `asX` throws on invalid input;
 * `tryX` returns `null`. Use `as*` at trust boundaries where input is
 * known-good (post-zod-validation, post-DB-read); use `try*` at boundaries
 * where input could be malformed (raw HTTP query parsing).
 */

export function asEventId(value: string): EventId {
  if (!value || value.length === 0) {
    throw new Error('EventId must be a non-empty string');
  }
  return value as EventId;
}

export function tryEventId(value: unknown): EventId | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value as EventId;
}

export function asRegistrationId(value: string): RegistrationId {
  if (!value || value.length === 0) {
    throw new Error('RegistrationId must be a non-empty string');
  }
  return value as RegistrationId;
}

export function tryRegistrationId(value: unknown): RegistrationId | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value as RegistrationId;
}

export function asExternalEventId(value: string): ExternalEventId {
  if (!value || value.length === 0) {
    throw new Error('ExternalEventId must be a non-empty string');
  }
  return value as ExternalEventId;
}

export function tryExternalEventId(value: unknown): ExternalEventId | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value as ExternalEventId;
}

export function asExternalAttendeeId(value: string): ExternalAttendeeId {
  if (!value || value.length === 0) {
    throw new Error('ExternalAttendeeId must be a non-empty string');
  }
  return value as ExternalAttendeeId;
}

export function tryExternalAttendeeId(
  value: unknown,
): ExternalAttendeeId | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value as ExternalAttendeeId;
}

/**
 * Lightweight RFC-5321 email shape check (matches the broader project
 * pattern in env.ts BROADCASTS_FROM_EMAIL). Application boundary (zod
 * schemas) does the strict canonical validation; this constructor exists
 * for already-validated boundary crossings.
 */
export function asAttendeeEmail(value: string): AttendeeEmail {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(`AttendeeEmail must be a valid email address (got ${value.length} chars)`);
  }
  return value as AttendeeEmail;
}

export function tryAttendeeEmail(value: unknown): AttendeeEmail | null {
  if (typeof value !== 'string') return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value as AttendeeEmail;
}

/**
 * Webhook secret constructor — enforces 32-byte base64url shape (≥43
 * chars + base64url alphabet only). Defence-in-depth against
 * accidentally rotating to a too-short secret OR a string that doesn't
 * round-trip through base64url decode. The actual entropy bound is
 * enforced at generation time in `generate-webhook-secret.ts` (Phase
 * 5 T070) via Node's `crypto.randomBytes`.
 *
 * Issue S4 (review 2026-05-12) — the original implementation accepted
 * `'a'.repeat(43)` (zero entropy, 43 chars) because length was the
 * only check. Adding the alphabet regex ensures the value at least
 * LOOKS like a base64url encoding (catches "all-same-char" + typo'd
 * secrets that happen to be ≥43 chars but contain `:` / `=` / spaces).
 * Cheap defence-in-depth alongside the crypto.randomBytes generator.
 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function asWebhookSecret(value: string): WebhookSecret {
  if (value.length < 43) {
    throw new Error(
      'WebhookSecret must be at least 43 chars (32 bytes base64url-encoded)',
    );
  }
  if (!BASE64URL_PATTERN.test(value)) {
    throw new Error(
      'WebhookSecret must use only base64url alphabet characters ([A-Za-z0-9_-])',
    );
  }
  return value as WebhookSecret;
}

export function tryWebhookSecret(value: unknown): WebhookSecret | null {
  if (typeof value !== 'string' || value.length < 43) return null;
  if (!BASE64URL_PATTERN.test(value)) return null;
  return value as WebhookSecret;
}

/**
 * X-Request-ID header value — non-empty string, ≤256 chars (defensive cap).
 */
export function asRequestId(value: string): RequestId {
  if (!value || value.length === 0 || value.length > 256) {
    throw new Error('RequestId must be a non-empty string ≤256 chars');
  }
  return value as RequestId;
}

export function tryRequestId(value: unknown): RequestId | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 256) return null;
  return value as RequestId;
}
