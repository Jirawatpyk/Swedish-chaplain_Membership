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

/**
 * Parse a free-text search query into a member-number integer, or `null` if it
 * is not a usable member-number query. Accepts the formatted form
 * (`SCCM-0042`), a zero-padded bare number (`0042`), or a bare number (`42`)
 * — all → `42`. Returns `null` for empty / whitespace-only / prefix-only
 * (`SCCM-`) / non-positive (`0`, `-1`, `0000`) / non-numeric (`NOT-A-NUMBER`,
 * `x`) input.
 *
 * Pure Application/Domain helper (no SQL, no route coupling). The directory
 * search route calls this; a non-null result drives an `eq(members.memberNumber)`
 * index hit, a null result falls through to the company/contact ILIKE branch.
 *
 * The digit segment is taken AFTER an optional trailing `PREFIX-`; leading
 * zeros are stripped by `Number()`. We intentionally do NOT brand the result
 * as `MemberNumber` — the parsed value is an untrusted search term, not a
 * constructed identity; callers compare it against the indexed column as a
 * plain integer.
 */
export function parseMemberNumberQuery(q: string): number | null {
  const trimmed = q.trim();
  if (trimmed.length === 0) return null;

  // Strip an optional leading `PREFIX-` (e.g. `SCCM-0042` → `0042`).
  // The remainder must be all digits — this rejects `SCCM-` (empty digits)
  // and `NOT-A-NUMBER` (non-digit remainder) alike.
  const digits = trimmed.replace(/^[A-Za-z][A-Za-z0-9]{0,7}-/, '');
  if (!/^\d+$/.test(digits)) return null;

  // Cap the digit count BEFORE `Number()`: a >15-digit all-digit query coerces
  // past Number.MAX_SAFE_INTEGER to an imprecise float that still passes the
  // `Number.isInteger && > 0` checks below — a silent overflow that would drive
  // an `eq(members.memberNumber)` probe with a wrong integer. A member number
  // won't exceed ~9 digits, so anything longer is not a member-number query.
  if (digits.length > 9) return null;

  const n = Number(digits);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
