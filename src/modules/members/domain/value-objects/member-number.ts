/**
 * MemberNumber — human-readable, per-tenant, lifetime-sequential display id
 * for a Member (e.g. `SCCM-0042`). The UUID `MemberId` remains the surrogate
 * PK and the only value used in URLs / backend lookups; MemberNumber is a
 * display identifier only (design 2026-06-05-member-number-design.md §7).
 *
 * Pure Domain — zero framework imports (Constitution Principle III). Reused by
 * the PDF template (Infrastructure) and API serializers (Presentation) via the
 * members public barrel.
 *
 * Mirrors the surrogate-UUID + human-readable-code pattern F4 uses for invoice
 * `DocumentNumber`. Prefix validation (`^[A-Z][A-Z0-9]{0,7}$`) lives on the
 * settings table CHECK, not here — the format helper trusts its prefix arg.
 */

declare const MemberNumberBrand: unique symbol;

/**
 * A validated, positive-integer member number. The brand is compile-time only;
 * the runtime value is the plain integer (so `SET last_number` round-trips and
 * `padStart` works directly). Construct via `asMemberNumber`.
 */
export type MemberNumber = number & { readonly [MemberNumberBrand]: true };

/**
 * Thrown by `asMemberNumber` when the input is not a positive integer.
 * A throwing constructor (vs `Result`) matches the value-object's invariant:
 * a non-positive-integer member number is a programmer/DB-corruption error
 * (the DB `CHECK (member_number > 0)` + allocator make it unreachable for
 * well-formed rows), not a recoverable user-input failure.
 */
export class InvalidMemberNumberError extends Error {
  readonly value: number;
  constructor(value: number) {
    super(`Invalid member number: ${value} (must be a positive integer)`);
    this.name = 'InvalidMemberNumberError';
    this.value = value;
  }
}

/**
 * Brand a raw number as a MemberNumber. Throws `InvalidMemberNumberError` on a
 * non-integer (incl. NaN) or a value <= 0. Used by `rowToMember()` to convert
 * `row.member_number` and by the allocator's returned `last_number`.
 */
export function asMemberNumber(n: number): MemberNumber {
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidMemberNumberError(n);
  }
  return n as MemberNumber;
}

/**
 * Render a MemberNumber as `{prefix}-{zeroPad}` — e.g. `SCCM-0042`.
 * `pad` defaults to 4 (`0001`–`9999`); `padStart` is a no-op once the
 * digit count meets/exceeds `pad`, so values past 9999 auto-expand
 * (`SCCM-10000`) with no truncation. Pure — used by the PDF template and
 * the API/portal serializers. The caller supplies the per-tenant `prefix`
 * (validated by the settings-table CHECK, not re-validated here).
 */
export function formatMemberNumber(
  prefix: string,
  n: MemberNumber,
  pad = 4,
): string {
  return `${prefix}-${String(n).padStart(pad, '0')}`;
}
