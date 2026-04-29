/**
 * T024 — `EmailLower` Domain value object (F7).
 *
 * Branded string carrying the lowercase + trim normalisation invariant
 * for any email used as a F7 key (`broadcast_deliveries.recipient_email_lower`,
 * `marketing_unsubscribes.email_lower`, custom recipient list entries).
 *
 * NOT an RFC-5321 strict validator — that responsibility belongs to the
 * Application-layer `EmailValidatorPort` (T028) which delegates to the
 * `email-validator@^2` package. Domain's role is "is this string safe
 * to store as `email_lower`": non-empty + ≤254 chars + minimal format
 * sanity (catches obvious typos before reaching the validator).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

declare const EmailLowerBrand: unique symbol;
export type EmailLower = string & { readonly [EmailLowerBrand]: true };

export type EmailLowerError =
  | { readonly code: 'email_lower.empty' }
  | { readonly code: 'email_lower.too_long'; readonly maxLength: 254 }
  | { readonly code: 'email_lower.invalid_format' };

// Minimal local-format regex — matches `local@domain.tld`. Strict
// RFC-5321 validation is delegated to `EmailValidatorPort`. This regex
// catches obvious typos (missing `@`, missing TLD) before reaching the
// stricter validator at the Application boundary.
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Unchecked brand cast. Use only in TRUSTED contexts:
 *   - DB row → domain mapping (the column is text-typed, content
 *     guaranteed by the `EmailValidatorPort` at write time)
 *   - Test fixtures
 *   - Round-trip through a value already constructed via `asEmailLower`
 *
 * For untrusted input use `asEmailLower` which validates + normalises.
 */
export function unsafeBrandEmailLower(raw: string): EmailLower {
  return raw as EmailLower;
}

/**
 * Validate-and-brand an `EmailLower` from an untrusted source.
 * Performs lowercase + trim normalisation; returns a typed `Result`.
 */
export function asEmailLower(raw: string): Result<EmailLower, EmailLowerError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return err({ code: 'email_lower.empty' });
  if (trimmed.length > 254) {
    return err({ code: 'email_lower.too_long', maxLength: 254 });
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    return err({ code: 'email_lower.invalid_format' });
  }
  return ok(trimmed.toLowerCase() as EmailLower);
}

export function isEmailLower(value: unknown): value is EmailLower {
  return typeof value === 'string' && asEmailLower(value).ok;
}
