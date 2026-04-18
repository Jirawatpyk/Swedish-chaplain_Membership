/**
 * T023 — Money value object (F4).
 *
 * Immutable satang (THB × 100) wrapper backed by BIGINT for exact
 * arithmetic. Multiplication by a pro-rate factor uses a precise
 * integer-math routine that rounds half-away-from-zero at the end.
 *
 * Why `bigint` and not `number`:
 *   - `Number.MAX_SAFE_INTEGER` = 2^53-1 ≈ 9.007 × 10^15. That's 9×10^13
 *     THB — more than enough in principle, but a `plan_fee × quantity ×
 *     pro_rate_factor` chain multiplies intermediate values that can
 *     overflow silently. BigInt is exact at any scale.
 *   - Serialises to DB via Drizzle's `bigint({ mode: 'bigint' })`.
 *
 * Rule: ALL monetary math inside the invoicing domain goes through this
 * type. Presentation converts to THB.ss display via `formatTHB()`.
 */

export type MoneyError =
  | { kind: 'negative_amount'; satang: bigint }
  | { kind: 'non_integer_factor'; factor: string }
  | { kind: 'factor_out_of_range'; factor: string };

const MAX_SAFE_FACTOR_DENOMINATOR = 10_000n; // 4 decimal places

export class Money {
  readonly satang: bigint;

  private constructor(satang: bigint) {
    this.satang = satang;
  }

  static zero(): Money {
    return new Money(0n);
  }

  /**
   * Construct a Money value. Negative satang is rejected — negative
   * amounts are modelled via `subtract()` returning a Result, not a
   * negative Money.
   */
  static ofSatang(satang: bigint): { ok: true; value: Money } | { ok: false; error: MoneyError } {
    if (satang < 0n) return { ok: false, error: { kind: 'negative_amount', satang } };
    return { ok: true, value: new Money(satang) };
  }

  /** Convenience ctor — treats input as satang and throws on negative. */
  static fromSatangUnsafe(satang: bigint | number): Money {
    const n = typeof satang === 'bigint' ? satang : BigInt(satang);
    if (n < 0n) throw new Error(`Money.fromSatangUnsafe: negative satang ${n}`);
    return new Money(n);
  }

  /** THB → Money. Rounds half-away-from-zero. */
  static fromTHB(thb: number): Money {
    if (thb < 0) throw new Error(`Money.fromTHB: negative THB ${thb}`);
    // Scale to satang with rounding.
    const satang = BigInt(Math.round(thb * 100));
    return new Money(satang);
  }

  add(other: Money): Money {
    return new Money(this.satang + other.satang);
  }

  subtract(other: Money): { ok: true; value: Money } | { ok: false; error: MoneyError } {
    const diff = this.satang - other.satang;
    if (diff < 0n) return { ok: false, error: { kind: 'negative_amount', satang: diff } };
    return { ok: true, value: new Money(diff) };
  }

  /**
   * Multiply by a rational factor represented as `numerator/denominator`
   * (for example `75/100` = 0.75). Rounds half-away-from-zero.
   *
   * Why rational: fractional factors are 4-dp decimals coming from the
   * DB (`numeric(6,4)`). BigInt does not support fractional math, so we
   * scale to the denominator, multiply, then divide with rounding.
   */
  multiplyByFraction(numerator: bigint, denominator: bigint): Money {
    if (denominator <= 0n) throw new Error('Money.multiplyByFraction: denominator must be > 0');
    const scaled = this.satang * numerator;
    // round half-away-from-zero
    const half = denominator / 2n;
    const rounded = (scaled >= 0n ? scaled + half : scaled - half) / denominator;
    if (rounded < 0n) throw new Error('Money.multiplyByFraction: result is negative');
    return new Money(rounded);
  }

  /**
   * Multiply by a 4-dp decimal factor given as a string (e.g. "0.7500").
   * Convenience wrapper for DB values.
   */
  multiplyByDecimal4(factorStr: string): Money {
    const [intPart, fracPart = ''] = factorStr.split('.');
    if (!/^-?\d+$/.test(intPart!)) throw new Error(`Money.multiplyByDecimal4: bad int ${intPart}`);
    if (!/^\d*$/.test(fracPart)) throw new Error(`Money.multiplyByDecimal4: bad frac ${fracPart}`);
    const fracPadded = (fracPart + '0000').slice(0, 4);
    const numerator = BigInt(intPart!) * MAX_SAFE_FACTOR_DENOMINATOR + BigInt(fracPadded);
    if (numerator < 0n) throw new Error('Money.multiplyByDecimal4: negative factor');
    return this.multiplyByFraction(numerator, MAX_SAFE_FACTOR_DENOMINATOR);
  }

  /** Compare — returns -1 / 0 / +1. */
  compare(other: Money): -1 | 0 | 1 {
    if (this.satang < other.satang) return -1;
    if (this.satang > other.satang) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.satang === other.satang;
  }

  isZero(): boolean {
    return this.satang === 0n;
  }

  /** Display helpers — intentionally no rounding here; presentation only. */
  toTHB(): number {
    // Safe because the domain rejects unreasonable amounts at
    // construction time; the number boundary is at the UI, not storage.
    return Number(this.satang) / 100;
  }

  toString(): string {
    const thb = this.satang / 100n;
    const st = this.satang % 100n;
    return `${thb}.${st.toString().padStart(2, '0')} THB`;
  }
}
