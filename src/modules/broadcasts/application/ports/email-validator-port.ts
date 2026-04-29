/**
 * T028 — `EmailValidatorPort` Application port (F7).
 *
 * RFC-5321 email format validation contract for FR-015d custom-segment
 * entries. Concrete adapter wraps the `email-validator@^2` package +
 * lowercase+trim normalisation. Stricter than the Domain
 * `EmailLower.asEmailLower()` minimal-format check — this port catches
 * RFC edge cases that the Domain VO's regex misses.
 *
 * Validation pipeline at submit boundary:
 *   1. Domain `asEmailLower(raw)` → normalises + minimal-format
 *   2. `EmailValidatorPort.validate(emailLower)` → RFC-5321 strict
 *   3. `MembersBridgePort.lookup*` / `EventAttendeesRepository` → tenant-graph resolution
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';

export type EmailValidationError =
  | { readonly kind: 'email_validation.empty' }
  | { readonly kind: 'email_validation.invalid_format'; readonly raw: string }
  | { readonly kind: 'email_validation.too_long'; readonly raw: string };

export interface EmailValidatorPort {
  /**
   * Validate an email against RFC-5321. Returns the lowercase+trim
   * normalised value on success.
   */
  validate(raw: string): Result<string, EmailValidationError>;
}
