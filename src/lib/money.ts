/**
 * F5R3 H-5 (2026-05-16) — branded money types for the Chamber-OS
 * THB satang minor unit.
 *
 * Why a brand?
 *   Pre-fix every money field across F4 (invoice totals) + F5 (payment
 *   amounts, refund amounts, Stripe gateway calls) + F8 (renewal money
 *   fields) was typed as `bigint`. A caller writing
 *     invoice.totalBaht * 100n      // mixing units
 *     Number(refund.amountSatang)   // boundary cast
 *     payment.amountSatang + invoice.discountBaht  // unit confusion
 *   compiled clean — the type system gave zero defence. F8 hit a 100x
 *   off-by-one bug (per project history); F5 + F4 both carry the same
 *   risk class.
 *
 * The brand turns these into compile errors. `Satang & bigint` is
 * runtime-identical to `bigint` (zero performance / serialisation
 * cost) but assignable only through the `asSatang(n: bigint)`
 * constructor which validates non-negative. Conversion to `number`
 * (for Stripe SDK boundaries) MUST go through `satangToProcessorAmount`
 * — that function is the single auditable point where the brand is
 * stripped.
 *
 * Adoption is incremental:
 *   • New code uses `Satang` from this module.
 *   • Existing `amountSatang: bigint` fields can stay typed as
 *     `bigint` until touched; explicit migration is a separate task
 *     because it touches ~30 files across F4+F5+F8.
 *
 * Future: `Cents`, `Pence`, `SEK_Ore` brands as siblings when F11
 * multi-currency lands. Each brand is disjoint so cross-currency
 * arithmetic also fails at compile time.
 */

declare const SatangBrand: unique symbol;

/**
 * THB minor unit (1 baht = 100 satang). Branded subtype of `bigint`
 * so values constructed via `asSatang` cannot be confused with raw
 * `bigint` (e.g. invoice totals in baht) at compile time.
 */
export type Satang = bigint & { readonly [SatangBrand]: true };

/**
 * Construct a `Satang` from a raw `bigint` already in minor unit.
 * THROWS on negative — the F5 / F4 domain invariant is non-negative
 * money throughout (refunds, invoices, payments all carry positive
 * amounts; sign is encoded in the use-case branch / column
 * discriminator, not in the value).
 */
export function asSatang(raw: bigint): Satang {
  if (raw < 0n) {
    throw new RangeError(`Satang must be >= 0; got ${raw.toString()}`);
  }
  return raw as Satang;
}

/**
 * Construct from a number/string that is KNOWN to be a minor-unit
 * integer. Use at DB / Stripe / parse boundaries where the value
 * is provably non-negative integer satang. THROWS on negative or
 * non-integer.
 */
export function parseSatang(value: number | string): Satang {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (!Number.isInteger(n)) {
    throw new RangeError(`Satang must be an integer; got ${value}`);
  }
  return asSatang(BigInt(n));
}

/**
 * `a + b` preserving the brand. Use instead of bare `a + b` so the
 * result stays branded (avoids needing an explicit re-cast).
 */
export function addSatang(a: Satang, b: Satang): Satang {
  return (a + b) as Satang;
}

/**
 * `a - b` preserving the brand. THROWS on underflow (b > a) —
 * subtracting more than you have is a domain invariant break
 * (refund > payment, etc.) and the caller should detect it before
 * calling.
 */
export function subSatang(a: Satang, b: Satang): Satang {
  if (b > a) {
    throw new RangeError(
      `Satang underflow: ${a.toString()} - ${b.toString()}`,
    );
  }
  return (a - b) as Satang;
}

/**
 * Boundary cast for the Stripe SDK + similar APIs that accept
 * `amount: number` in minor unit. Single auditable site where the
 * brand is stripped. Validates the value fits inside
 * `Number.MAX_SAFE_INTEGER` (~9e15 satang = 90 trillion baht) since
 * Stripe's PaymentIntent / Refund / Charge `amount` field is a JS
 * Number.
 *
 * If a future tenant transacts > 90T baht we have bigger problems.
 */
export function satangToProcessorAmount(s: Satang): number {
  if (s > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `Satang value ${s.toString()} exceeds Number.MAX_SAFE_INTEGER (~9e15)`,
    );
  }
  return Number(s);
}

/**
 * Format a `Satang` value as a `"1234.56"` two-decimal baht string.
 * Splits into integer-baht + remainder-satang to avoid float
 * coercion on values that exceed `Number.MAX_SAFE_INTEGER`.
 *
 * Mirrors the formatter inlined in
 * `src/modules/invoicing/application/use-cases/export-paid-invoices-csv.ts`
 * — when more F4/F5 surfaces adopt `Satang`, prefer this canonical
 * helper.
 */
export function formatSatangAsBaht(s: Satang): string {
  const baht = s / 100n;
  const remainder = s % 100n;
  return `${baht.toString()}.${remainder.toString().padStart(2, '0')}`;
}
