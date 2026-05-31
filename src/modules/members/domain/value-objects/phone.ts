/**
 * Phone value object — E.164 validator + branded type.
 *
 * E.164 spec: `+[country-code][subscriber]`, 8..15 digits after the `+`.
 * We strip ASCII formatting characters (spaces, hyphens, parens) before
 * validation so UI-entered "+66 81-234-5678" round-trips to "+66812345678".
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';

declare const PhoneBrand: unique symbol;
export type Phone = string & { readonly [PhoneBrand]: true };

export type PhoneError =
  | { code: 'phone.empty' }
  | { code: 'phone.invalid_format' };

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export function asPhone(raw: string): Result<Phone, PhoneError> {
  const stripped = raw.replace(/[\s\-()]/g, '');
  if (stripped.length === 0) return err({ code: 'phone.empty' });
  if (!E164_REGEX.test(stripped))
    return err({ code: 'phone.invalid_format' });
  return ok(stripped as Phone);
}

export function isPhone(value: unknown): value is Phone {
  return typeof value === 'string' && asPhone(value).ok;
}

/**
 * Form-level acceptance check: a phone INPUT is acceptable when it is
 * empty (the field is optional on member/contact forms) OR a valid E.164
 * number once ASCII formatting is stripped. Delegates to `asPhone` so the
 * regex + strip rule lives in exactly one place — client-side form
 * validation (member-form, contact-form-dialog) and the server-side
 * value object can never drift. Pure TS; safe to import from client
 * components (this module pulls only `@/lib/result`).
 */
export function isAcceptablePhoneInput(raw: string): boolean {
  return raw.trim() === '' || asPhone(raw).ok;
}
