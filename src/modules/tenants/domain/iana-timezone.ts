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
 *
 * Validation uses the runtime's `Intl` tz registry, NOT js-joda. This file
 * is re-exported by the `@/modules/tenants` barrel, which dozens of client
 * components reach (e.g. member form → `members/domain/member.ts`), and
 * `import '@js-joda/timezone'` is an un-tree-shakeable side effect that put
 * ~900 KB of tz data into every one of those client bundles. Server code
 * that does zone arithmetic imports js-joda + its tz data itself.
 * Guarded by `tests/unit/architecture/member-form-no-js-joda.test.ts`.
 */
import { err, ok, type Result } from '@/lib/result';

declare const IanaTzBrand: unique symbol;

export type IanaTimezone = string & { readonly [IanaTzBrand]: true };

export type IanaTimezoneError = {
  readonly kind: 'iana.invalid';
  readonly raw: string;
};

/** A `/`-segment starting lower-case — no tzdb id has one. */
const LOWERCASE_SEGMENT = /(^|\/)[a-z]/;

/**
 * Smart constructor — validates `raw` against the IANA tz registry and
 * returns a branded `IanaTimezone` on success. Use this at any
 * external/untrusted boundary (HTTP body, database column, env var, …).
 *
 * Same `Intl.DateTimeFormat` check as the `TENANT_TIMEZONE` boot validator
 * in `src/lib/env.ts`, plus case-sensitivity: `Intl` resolves ids
 * case-insensitively, but the branded value is handed to js-joda
 * `ZoneId.of` on the server, which is case-sensitive — so a mis-cased id
 * (`asia/bangkok`) is rejected here rather than failing later. `raw` is
 * returned as-is (links such as `Asia/Calcutta` are not canonicalised).
 * Offset literals (`GMT+7`, `Z`) are not IANA ids and are rejected.
 */
export function asIanaTimezone(
  raw: string,
): Result<IanaTimezone, IanaTimezoneError> {
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone;
  } catch {
    return err({ kind: 'iana.invalid', raw });
  }
  const misCased =
    LOWERCASE_SEGMENT.test(raw) ||
    (resolved !== raw && resolved.toLowerCase() === raw.toLowerCase());
  if (misCased) return err({ kind: 'iana.invalid', raw });
  return ok(raw as IanaTimezone);
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
