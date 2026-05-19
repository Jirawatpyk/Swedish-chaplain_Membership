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
 * Branded-type smart constructors.
 *
 * **Trust model** (Phase H3.3 hardening — Round 3 R3.5.2 documented):
 *
 * UUID-PK-backed brands have TWO constructor variants:
 * - **Default validated** `asEventId` / `asRegistrationId` (+ `tryEventId` /
 *   `tryRegistrationId`) — checks UUID v4 shape via `UUID_V4_PATTERN`.
 *   Use at HTTP / CSV / external trust boundaries.
 * - **`*Unchecked` hot-path variant** `asEventIdUnchecked` /
 *   `asRegistrationIdUnchecked` (+ `try*Unchecked`) — non-empty string
 *   check only. Reserved for Drizzle row reads where Postgres
 *   `uuid DEFAULT gen_random_uuid()` column type already guarantees
 *   the shape. ESLint rule scoped to `src/modules/events/infrastructure/**`
 *   (eslint.config.mjs:621-678) enforces this — relative-import
 *   bypass also blocked per R3.4.1.
 *
 * **External-ID brands** (`ExternalEventId` / `ExternalAttendeeId`) are
 * NOT backed by Postgres `uuid` columns — they originate from CSV cells
 * or webhook payload fields with variable-format identifiers
 * (EventCreate emits snake_case strings). The length-only `as*`
 * constructor stays — callers MUST validate the format at the ingest
 * boundary (canonical shape is feature-specific). The `tryExternalEventId`
 * /  `tryExternalAttendeeId` variants apply the same non-empty check.
 *
 * **Brand-boundary audit convention** (Round-3 types-H1 closure):
 *
 * Every `as*` callsite that brands untrusted input (HTTP path param,
 * body field, header, CSV cell, webhook payload) MUST be preceded by
 * a `// brand-boundary: <validation-source>` comment that documents
 * WHERE the UUID-shape (or external-id-shape) check happened. Format:
 *
 * ```ts
 * // brand-boundary: UUID_V4 regex at line N OR zod parse at line N
 * eventId: asEventId(eventId),
 * ```
 *
 * Callsites that brand TRUSTED input do NOT need the comment:
 *   - Drizzle row reads (DB type guarantees the shape for uuid PKs)
 *   - Test fixtures (constructors with `mkEventId(...)` helpers —
 *     see `tests/helpers/brand-fixtures.ts`)
 *   - Re-branding within Application/Infrastructure boundaries
 *
 * Future PR reviewers SHOULD grep for new `as(EventId|Registration|
 * Member|User)Id\(` callsites in route handlers and verify each
 * carries the boundary comment. A CI custom ESLint rule was
 * considered but deferred — manual review with grep is sufficient at
 * F6 scale (~5 new callsites per feature). Promote to ESLint rule if
 * audit drift becomes a recurring review finding.
 */

/**
 * Phase C C3 / Phase H3.3 — UUID v4 regex shared with
 * `csv-import-record-id.ts`. After H3.3:
 *
 * - **Default constructors** `asEventId` / `asRegistrationId` validate
 *   UUID v4 shape. Use at HTTP / CSV / external trust boundaries.
 * - **Unchecked variants** `asEventIdUnchecked` / `asRegistrationIdUnchecked`
 *   skip the regex for hot-path Drizzle row reads where the DB column
 *   `uuid DEFAULT gen_random_uuid()` already guarantees the shape.
 *   These are confined by ESLint rule to `src/modules/events/infrastructure/**`.
 *
 * - `asExternalEventId` / `asExternalAttendeeId` stay UNCHANGED — these
 *   are EventCreate slug-strings, NOT UUIDs. Length-only check is correct.
 */
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Default — validates UUID v4 shape. Use at HTTP / CSV / external boundaries. */
export function asEventId(value: string): EventId {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new Error(`EventId must be a UUID v4 (got ${value.length} chars)`);
  }
  return value as EventId;
}

/**
 * Unchecked variant — skips UUID v4 regex. Reserved for hot-path
 * Drizzle row reads (DB column is `uuid DEFAULT gen_random_uuid()`).
 * ESLint banned outside `src/modules/events/infrastructure/**`.
 */
export function asEventIdUnchecked(value: string): EventId {
  if (!value || value.length === 0) {
    throw new Error('EventId must be a non-empty string');
  }
  return value as EventId;
}

export function tryEventId(value: unknown): EventId | null {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) return null;
  return value as EventId;
}

export function tryEventIdUnchecked(value: unknown): EventId | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value as EventId;
}

export function asRegistrationId(value: string): RegistrationId {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new Error(
      `RegistrationId must be a UUID v4 (got ${value.length} chars)`,
    );
  }
  return value as RegistrationId;
}

export function asRegistrationIdUnchecked(value: string): RegistrationId {
  if (!value || value.length === 0) {
    throw new Error('RegistrationId must be a non-empty string');
  }
  return value as RegistrationId;
}

export function tryRegistrationId(value: unknown): RegistrationId | null {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) return null;
  return value as RegistrationId;
}

export function tryRegistrationIdUnchecked(
  value: unknown,
): RegistrationId | null {
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
 * A length-only check would accept `'a'.repeat(43)` (zero entropy).
 * The alphabet regex ensures the value at least LOOKS like a
 * base64url encoding — catches all-same-char + typo'd secrets that
 * happen to be ≥43 chars but contain `:` / `=` / spaces. Cheap
 * defence-in-depth alongside the crypto.randomBytes generator.
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
 * X-Request-ID header value — non-empty printable-ASCII string, ≤256
 * chars (defensive cap). Charset check matches `asWebhookSecret`
 * defensive posture: an attacker passing 256 NUL bytes would otherwise
 * pass the length-only check.
 */
const REQUEST_ID_PATTERN = /^[\x21-\x7E]+$/;

export function asRequestId(value: string): RequestId {
  if (!value || value.length === 0 || value.length > 256) {
    throw new Error('RequestId must be a non-empty string ≤256 chars');
  }
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new Error('RequestId must contain only printable ASCII characters');
  }
  return value as RequestId;
}

export function tryRequestId(value: unknown): RequestId | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 256) return null;
  if (!REQUEST_ID_PATTERN.test(value)) return null;
  return value as RequestId;
}
