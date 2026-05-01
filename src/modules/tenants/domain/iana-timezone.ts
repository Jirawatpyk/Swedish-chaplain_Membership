/**
 * Branded `IanaTimezone` value object — IANA timezone identifier
 * (e.g. `Asia/Bangkok`, `Europe/Stockholm`, `UTC`).
 *
 * The brand carries no runtime cost — it's a phantom type that lets
 * type signatures express "this string has been validated as a real
 * IANA tz name" without re-validating at every call site. Validation
 * happens once at the boundary via `asIanaTimezone(raw)` (smart
 * constructor, parse-don't-validate per Constitution Principle III).
 *
 * Project pattern: mirrors `EmailLower`, `BroadcastId`, `TenantContext`
 * — branded VOs that propagate invariants across module boundaries.
 */
import { ZoneId } from '@js-joda/core';
import '@js-joda/timezone';
import { err, ok, type Result } from '@/lib/result';

declare const IanaTzBrand: unique symbol;

export type IanaTimezone = string & { readonly [IanaTzBrand]: true };

export type IanaTimezoneError = {
  readonly kind: 'iana.invalid';
  readonly raw: string;
};

/**
 * Smart constructor — validates `raw` against the js-joda IANA tz
 * registry and returns a branded `IanaTimezone` on success. Use this
 * at any external/untrusted boundary (HTTP body, database column,
 * env var, …).
 */
export function asIanaTimezone(
  raw: string,
): Result<IanaTimezone, IanaTimezoneError> {
  try {
    ZoneId.of(raw);
    return ok(raw as IanaTimezone);
  } catch {
    return err({ kind: 'iana.invalid', raw });
  }
}

/**
 * Trusted-context cast for build-time-known constants. Throws if the
 * literal isn't a valid IANA id — surfaces typos at module-load
 * rather than silently rendering UTC.
 */
export function unsafeIanaTimezone(literal: string): IanaTimezone {
  const r = asIanaTimezone(literal);
  if (!r.ok) {
    throw new Error(`unsafeIanaTimezone: invalid IANA tz literal "${literal}"`);
  }
  return r.value;
}
