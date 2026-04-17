/**
 * Email value object — RFC 5321 validator + branded type.
 *
 * Branded so an arbitrary string cannot flow into a function that expects
 * a validated email. Length cap 254 matches RFC 5321 "Practical maximum".
 * Normalized to lowercase for per-tenant uniqueness matching (the DB
 * partial unique index uses `lower(email)` — keeping Domain and DB in sync).
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';

declare const EmailBrand: unique symbol;
export type Email = string & { readonly [EmailBrand]: true };

export type EmailError =
  | { code: 'email.empty' }
  | { code: 'email.too_long'; maxLength: 254 }
  | { code: 'email.invalid_format' };

// RFC 5322 simplified — one `@`, at least one `.` in the domain, no whitespace.
// We intentionally reject some technically-valid exotic forms (quoted locals,
// IP-literal domains) because Chamber-OS never needs them and they expand
// the attack surface of downstream systems (e.g. Thai invoice PDF renderer).
const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function asEmail(raw: string): Result<Email, EmailError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return err({ code: 'email.empty' });
  if (trimmed.length > 254)
    return err({ code: 'email.too_long', maxLength: 254 });
  if (!EMAIL_REGEX.test(trimmed))
    return err({ code: 'email.invalid_format' });
  return ok(trimmed.toLowerCase() as Email);
}

export function isEmail(value: unknown): value is Email {
  return typeof value === 'string' && asEmail(value).ok;
}
