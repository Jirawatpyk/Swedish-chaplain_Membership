/**
 * Branded ULID-like id helper.
 *
 * Eliminates the duplicated `RE_ULID_LIKE` regex + parser scaffold
 * that appears in `payment.ts` and `refund.ts` — both id types use
 * the same Crockford base32 alphabet (digits + letters minus
 * I/L/O/U) with a 20–40 char length budget covering `<prefix>_<ulid>`
 * shapes (e.g. `pmt_…`, `rfnd_…`).
 *
 * Branding is per-id-type (each Domain entity declares its own
 * `unique symbol` brand); this factory provides only the parser
 * scaffold + the shared regex. Consumers narrow the return type via
 * the type parameters.
 *
 * Pure TypeScript — no framework/ORM imports.
 */

/**
 * Permissive ULID-like regex shared across all Chamber-OS branded
 * domain id types. Crockford base32 alphabet excludes `I`, `L`,
 * `O`, `U` (visual-ambiguity avoidance with 1, 1, 0, V); `_` is
 * permitted as the prefix separator (`pmt_…`, `rfnd_…`,
 * `inv_…`, etc.).
 *
 * Strict Crockford ULID parsers reject `_`; we allow it because
 * this is a boundary guard against wildly-wrong input (empty
 * strings, injection attempts). Authoritative uniqueness is
 * enforced by the DB UNIQUE constraint on each id column.
 *
 * Character set spelled out for readability:
 *   digits        0-9
 *   uppercase     A B C D E F G H   J K   M N   P Q R S T   V W X Y Z
 *                                  ^(no I)   ^(no L)(no O)     ^(no U)
 *   lowercase     a b c d e f g h   j k   m n   p q r s t   v w x y z
 *   separator     _
 *   length        20–40 chars (covers `<prefix>_` + 26-char ULID body
 *                 + headroom for future prefix schemes)
 */
export const RE_ULID_LIKE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z_]{20,40}$/;

export interface UlidIdHelpers<
  TId extends string,
  TErrorKind extends string,
> {
  /** Unchecked brand cast — use in TRUSTED contexts (DB row → Domain). */
  readonly as: (raw: string) => TId;
  /** Validated parse — use at route/webhook boundaries. */
  readonly parse: (
    raw: string,
  ) => { ok: true; value: TId } | { ok: false; error: { readonly kind: TErrorKind; readonly raw: string } };
}

/**
 * Build the standard `as*` + `parse*` helper pair for a branded
 * ULID-like id type. Each Domain entity declares its own brand
 * symbol + literal `errorKind` and passes both into this factory.
 *
 * Example (payment.ts):
 *
 *   declare const PaymentIdBrand: unique symbol;
 *   export type PaymentId = string & { readonly [PaymentIdBrand]: true };
 *   export type PaymentIdError = { readonly kind: 'invalid_payment_id'; readonly raw: string };
 *   const helpers = makeUlidIdHelpers<PaymentId, 'invalid_payment_id'>('invalid_payment_id');
 *   export const asPaymentId = helpers.as;
 *   export const parsePaymentId = helpers.parse;
 */
export function makeUlidIdHelpers<
  TId extends string,
  TErrorKind extends string,
>(errorKind: TErrorKind): UlidIdHelpers<TId, TErrorKind> {
  return {
    as: (raw: string): TId => raw as TId,
    parse: (raw: string) => {
      if (RE_ULID_LIKE.test(raw)) {
        return { ok: true as const, value: raw as TId };
      }
      return { ok: false as const, error: { kind: errorKind, raw } };
    },
  };
}
