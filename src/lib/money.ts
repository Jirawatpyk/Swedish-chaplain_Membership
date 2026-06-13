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

declare const TrustedBrand: unique symbol;
declare const UntrustedBrand: unique symbol;

/**
 * F5R5 BLOCKER fix (2026-05-16) — brand design re-architected from
 * nested intersection (`Satang & UntrustedSatang`) to DISJOINT
 * SIBLINGS. R4 review proved the prior nested shape was structurally
 * INVERTED — `UntrustedSatang` had MORE brand constraints than
 * `Satang`, making it a *subtype* of `Satang` under TS structural
 * typing → freely assignable to `Satang`-typed slots → arithmetic
 * helpers silently accepted unchecked values. M-5's compile-time
 * enforcement claim was theatre.
 *
 * Now: `Satang` and `UntrustedSatang` are siblings — neither is
 * assignable to the other without an explicit cast through one of
 * the constructors (`asSatang` revalidates non-negative; the
 * implicit `as Satang` would be flagged by an eslint rule). The
 * arithmetic helpers `addSatang` / `subSatang` accept only `Satang`
 * → passing an `UntrustedSatang` is a TS2345 compile error. This
 * actually closes the "policy-only enforcement" gap.
 *
 * Verified via TS probe:
 *   - `addSatang(asSatangUnchecked(-1n), asSatang(0n))` → TS2345
 *   - `const s: Satang = asSatangUnchecked(0n)` → TS2322
 *   - `const u: UntrustedSatang = asSatang(0n)` → TS2322
 */

/**
 * THB minor unit (1 baht = 100 satang). Branded `bigint` carrying
 * the non-negative invariant; constructed via `asSatang`.
 */
export type Satang = bigint & { readonly [TrustedBrand]: true };

/**
 * Forensic-escape sibling brand for err-payload values that bypassed
 * `asSatang`'s non-negative gate (B-1 forensic-preservation
 * contract). Constructed ONLY via `asSatangUnchecked`. Disjoint from
 * `Satang` so:
 *   - `addSatang`/`subSatang` reject `UntrustedSatang` at compile.
 *   - A `Satang`-typed field cannot silently absorb an
 *     `UntrustedSatang` from an err payload.
 *   - Logging / audit / display sites that accept either accept the
 *     explicit union `Satang | UntrustedSatang`.
 */
export type UntrustedSatang = bigint & { readonly [UntrustedBrand]: true };

/**
 * Construct a `Satang` from a raw `bigint` already in minor unit.
 * THROWS on negative — the F5 / F4 domain invariant is non-negative
 * money throughout (refunds, invoices, payments all carry positive
 * amounts; sign is encoded in the use-case branch / column
 * discriminator, not in the value).
 */
/**
 * Observability contract (F5R5 M-2): the thrown class is `RangeError`
 * and the message prefix is `Satang must be >= 0`. Both are part of
 * the SRE alert + runbook surface. DO NOT change the class or the
 * prefix without coordinating with `docs/observability.md`. The
 * regression test at `tests/unit/lib/money.test.ts` pins both.
 */
export function asSatang(raw: bigint): Satang {
  if (raw < 0n) {
    throw new RangeError(`Satang must be >= 0; got ${raw.toString()}`);
  }
  return raw as Satang;
}

/**
 * F5R3v2 B-1 + F5R3v4 M-5 (2026-05-16) — diagnostic / forensic
 * escape hatch.
 *
 * Apply the `UntrustedSatang` brand WITHOUT running the non-negative
 * validation. Use ONLY at error-payload construction sites where the
 * caller is intentionally preserving a possibly-corrupted value for
 * forensics (e.g. `credit_exceeds_remainder` carries the offending
 * proposed/remaining values — if those happen to be negative due to a
 * data-integrity bug, the err-path is precisely the surface that must
 * NOT throw and lose the diagnostic).
 *
 * Pre-fix the R3 H-5 migration used `asSatang(...)` at error-payload
 * sites. A negative value would throw `RangeError` inside the
 * error-construction expression, escape the err-branch, propagate to
 * the outer tracer catch, and become a generic 500 with no money
 * breakdown in audit_log. The whole point of these typed errors is
 * surfacing exactly that breakdown.
 *
 * Type-level enforcement (M-5): returns `UntrustedSatang`, NOT
 * `Satang`. The arithmetic helpers (`addSatang`, `subSatang`) only
 * accept `Satang`, so an `UntrustedSatang` from this helper CANNOT
 * be silently arithmetic-folded into trusted-value chains at compile
 * time. To re-validate an UntrustedSatang you've cleansed, pass it
 * through `asSatang(value as bigint)` — the cast is intentional and
 * forces a code review.
 *
 * Production callsites — locate via `rg asSatangUnchecked` (avoid
 * an enumerated list here — it rots fast: pre-fix R4 review flagged
 * the prior list as already-stale after one iteration).
 * Adding new callers requires the same forensic-payload justification.
 */
export function asSatangUnchecked(raw: bigint): UntrustedSatang {
  return raw as UntrustedSatang;
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

/**
 * Format permitted by Postgres `decimal(12,2)` — non-negative, ≤2
 * fractional digits. Shared by every THB-decimal→satang parse so the
 * accepted shape is defined once.
 */
export const VALID_THB_DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Parse a non-negative `decimal(12,2)` THB string (e.g. "50000.50")
 * into branded `Satang` using INTEGER-ONLY arithmetic — split on `.`,
 * left-pad the fractional part to two digits, concatenate, `BigInt`.
 *
 * Why integer-only (NOT `parseFloat(thb) * 100`): a float multiply
 * drifts on borderline values (IEEE-754) and silently charges the
 * wrong amount on a tax document. The F8 frozen-price billing path
 * (§86/4, FR-022) and `cycleFrozenPriceSatang` are the single
 * conversion sites for cross-module bigint money — both route through
 * here so there is exactly one parser to audit.
 *
 * THROWS on a malformed/negative input (the DB CHECK + Application
 * invariants reject these upstream; this is the last-line defence).
 */
export function parseThbDecimalToSatang(thb: string): Satang {
  if (!VALID_THB_DECIMAL_RE.test(thb)) {
    throw new RangeError(
      `parseThbDecimalToSatang: malformed THB decimal "${thb}" — expected decimal(12,2) format`,
    );
  }
  const [intPart, fracRaw = ''] = thb.split('.');
  const frac = (fracRaw + '00').slice(0, 2);
  return asSatang(BigInt(`${intPart}${frac}`));
}
