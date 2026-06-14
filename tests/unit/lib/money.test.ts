/**
 * F5R3 H-5 (2026-05-16) — unit coverage for the branded `Satang`
 * money type + helpers in `@/lib/money`.
 *
 * The brand is a TYPE-only construct (zero runtime overhead) so the
 * tests here focus on:
 *   1. Runtime invariants the constructors enforce (non-negative,
 *      integer, MAX_SAFE_INTEGER ceiling).
 *   2. Arithmetic helpers preserve correctness on bigint boundaries.
 *   3. The formatter handles edge cases (zero, < 100 satang, large
 *      values that exceed Number.MAX_SAFE_INTEGER).
 *
 * Compile-time brand enforcement is exercised across F4+F5+F8 as
 * call sites migrate to `Satang`; the soft-launch in R3 only ships
 * this foundation file + this test.
 */
import { describe, expect, it } from 'vitest';

import {
  addSatang,
  asSatang,
  asSatangUnchecked,
  formatSatangAsBaht,
  parseSatang,
  parseThbDecimal,
  parseThbDecimalToSatang,
  satangToProcessorAmount,
  subSatang,
  type ThbDecimal,
  type UntrustedSatang,
} from '@/lib/money';

describe('asSatang', () => {
  it('accepts zero', () => {
    const s = asSatang(0n);
    expect(s).toBe(0n);
  });

  it('accepts positive bigint', () => {
    const s = asSatang(1_000_000n);
    expect(s).toBe(1_000_000n);
  });

  it('accepts very large bigint (>MAX_SAFE_INTEGER)', () => {
    // The brand constructor itself does NOT clamp to MAX_SAFE_INTEGER —
    // only the processor-boundary cast does. A 90-trillion-baht
    // invoice is legal in domain, just not serialisable to Stripe.
    const huge = BigInt(Number.MAX_SAFE_INTEGER) * 2n;
    const s = asSatang(huge);
    expect(s).toBe(huge);
  });

  it('throws on negative bigint', () => {
    expect(() => asSatang(-1n)).toThrow(RangeError);
    expect(() => asSatang(-1n)).toThrow(/must be >= 0/);
  });
});

/**
 * F5R3v3 H-6 (2026-05-16) — asSatangUnchecked direct coverage.
 *
 * Pre-fix R3v2 Batch 1 added `asSatangUnchecked` (B-1 forensic escape
 * for err-payload values that may be corrupt) but tests-reviewer
 * flagged it had ZERO unit tests. If a future maintainer "fixes" it
 * to validate non-negative, all 3 production callsites silently
 * regress to BLOCKER-class B-1 behavior (RangeError mid-error-
 * construction → generic 500 + lost diagnostic). These tests pin the
 * "do NOT validate" contract.
 */
describe('asSatangUnchecked (B-1 forensic escape)', () => {
  it('accepts negative bigint WITHOUT throwing — REGRESSION GUARD for B-1', () => {
    expect(() => asSatangUnchecked(-1n)).not.toThrow();
    expect(asSatangUnchecked(-1n)).toBe(-1n);
    expect(asSatangUnchecked(-1_000_000n)).toBe(-1_000_000n);
  });

  it('accepts zero and large positive bigint', () => {
    expect(asSatangUnchecked(0n)).toBe(0n);
    expect(asSatangUnchecked(1_000_000_000_000n)).toBe(1_000_000_000_000n);
  });

  it('returned value carries UntrustedSatang brand (NOT assignable to Satang)', () => {
    // F5R5 BLOCKER fix (2026-05-16) — disjoint sibling brands prove
    // their value HERE: assigning `asSatangUnchecked(...)` (returns
    // `UntrustedSatang`) into a `Satang` slot is TS2322 (verified at
    // build time). Asserting at runtime that the value carries the
    // structural bigint behaviour is enough — the type system enforces
    // the rest.
    const v: UntrustedSatang = asSatangUnchecked(42n);
    expect(typeof v).toBe('bigint');
    expect(v).toBe(42n);
  });

  it('arithmetic helpers REJECT UntrustedSatang at compile time (M-5 contract)', () => {
    // The whole point of the disjoint brand: `addSatang(unchecked, ...)`
    // would be TS2345. The runtime check here is moot — the
    // compile-time contract IS the safety guarantee. If a future
    // maintainer collapses the brand into a single shared symbol,
    // `tests/types/money-brand.test-d.ts` (the type-level companion
    // test, post-R5) will catch the regression.
    const corrupt: UntrustedSatang = asSatangUnchecked(-100n);
    expect(typeof corrupt).toBe('bigint');
    expect(corrupt).toBe(-100n);
    // INTENTIONALLY no `addSatang(corrupt, ...)` call — the type
    // system rejects it; calling via `as Satang` would defeat the
    // guard. See the type-test file for the compile-error proof.
  });
});

describe('parseSatang', () => {
  it('parses integer number', () => {
    expect(parseSatang(123)).toBe(123n);
  });

  it('parses integer string', () => {
    expect(parseSatang('456')).toBe(456n);
  });

  it('throws on non-integer number', () => {
    expect(() => parseSatang(1.5)).toThrow(RangeError);
  });

  it('throws on negative', () => {
    expect(() => parseSatang(-5)).toThrow(RangeError);
    expect(() => parseSatang('-5')).toThrow(RangeError);
  });

  it('throws on NaN', () => {
    expect(() => parseSatang(NaN)).toThrow(RangeError);
  });
});

describe('addSatang', () => {
  it('adds two values', () => {
    const a = asSatang(100n);
    const b = asSatang(50n);
    expect(addSatang(a, b)).toBe(150n);
  });

  it('handles zero', () => {
    const a = asSatang(0n);
    const b = asSatang(100n);
    expect(addSatang(a, b)).toBe(100n);
  });
});

describe('subSatang', () => {
  it('subtracts two values', () => {
    const a = asSatang(100n);
    const b = asSatang(30n);
    expect(subSatang(a, b)).toBe(70n);
  });

  it('handles zero result', () => {
    const a = asSatang(100n);
    expect(subSatang(a, a)).toBe(0n);
  });

  it('throws on underflow (b > a)', () => {
    const a = asSatang(50n);
    const b = asSatang(100n);
    expect(() => subSatang(a, b)).toThrow(RangeError);
    expect(() => subSatang(a, b)).toThrow(/underflow/);
  });
});

describe('satangToProcessorAmount', () => {
  it('converts to number for typical THB invoice (฿1000.00)', () => {
    expect(satangToProcessorAmount(asSatang(100_000n))).toBe(100_000);
  });

  it('converts zero', () => {
    expect(satangToProcessorAmount(asSatang(0n))).toBe(0);
  });

  it('throws on value > MAX_SAFE_INTEGER', () => {
    const tooBig = asSatang(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => satangToProcessorAmount(tooBig)).toThrow(RangeError);
    expect(() => satangToProcessorAmount(tooBig)).toThrow(
      /exceeds Number.MAX_SAFE_INTEGER/,
    );
  });

  it('accepts exactly MAX_SAFE_INTEGER as the upper boundary', () => {
    const max = asSatang(BigInt(Number.MAX_SAFE_INTEGER));
    expect(satangToProcessorAmount(max)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('formatSatangAsBaht', () => {
  it('formats whole baht', () => {
    expect(formatSatangAsBaht(asSatang(100n))).toBe('1.00');
    expect(formatSatangAsBaht(asSatang(100_000n))).toBe('1000.00');
  });

  it('formats sub-baht (< 100 satang)', () => {
    expect(formatSatangAsBaht(asSatang(1n))).toBe('0.01');
    expect(formatSatangAsBaht(asSatang(50n))).toBe('0.50');
    expect(formatSatangAsBaht(asSatang(99n))).toBe('0.99');
  });

  it('formats zero', () => {
    expect(formatSatangAsBaht(asSatang(0n))).toBe('0.00');
  });

  it('formats mixed baht + satang', () => {
    expect(formatSatangAsBaht(asSatang(12345n))).toBe('123.45');
  });

  it('handles values exceeding Number.MAX_SAFE_INTEGER without float coercion', () => {
    // 1e16 satang = 1e14 baht (~100 trillion baht). Float arithmetic
    // would lose precision; bigint arithmetic doesn't.
    const huge = asSatang(BigInt('10000000000000000'));
    expect(formatSatangAsBaht(huge)).toBe('100000000000000.00');
  });
});

describe('parseThbDecimalToSatang (F8 FR-022 frozen-price parse)', () => {
  it('parses a NON-ZERO satang remainder exactly', () => {
    // The §86/4 frozen-price case: 50000.50 THB → 5_000_050 satang.
    // (50000.50 is exactly representable as a double, so it is NOT a
    //  float-drift demonstrator — that is the next test; this one just
    //  pins the non-zero-satang remainder path.)
    expect(parseThbDecimalToSatang(parseThbDecimal('50000.50'))).toBe(
      5_000_050n,
    );
  });

  it('does NOT drift on a value that float-multiply gets wrong', () => {
    // The reason the parser is integer-only: 8.20 and 0.29 are NOT
    // exactly representable as doubles, so the naive
    // `Math.floor(parseFloat(x) * 100)` UNDER-bills by 1 satang on a
    // §86/4 tax document:
    //   parseFloat("8.20") * 100 === 819.9999999999999  → floor 819 (WRONG)
    //   parseFloat("0.29") * 100 === 28.999999999999996 → floor  28 (WRONG)
    // The integer parser splits on '.' and never touches a float.
    expect(Math.floor(parseFloat('8.20') * 100)).toBe(819); // proves the drift exists
    expect(parseThbDecimalToSatang(parseThbDecimal('8.20'))).toBe(820n); // the correct value
    expect(Math.floor(parseFloat('0.29') * 100)).toBe(28);
    expect(parseThbDecimalToSatang(parseThbDecimal('0.29'))).toBe(29n);
  });

  it('parses whole baht (no decimal point)', () => {
    expect(parseThbDecimalToSatang(parseThbDecimal('50000'))).toBe(5_000_000n);
  });

  it('parses two-decimal whole-satang', () => {
    expect(parseThbDecimalToSatang(parseThbDecimal('180000.00'))).toBe(
      18_000_000n,
    );
  });

  it('left-pads a single fractional digit (".5" → 50 satang)', () => {
    expect(parseThbDecimalToSatang(parseThbDecimal('1.5'))).toBe(150n);
  });

  it('parses zero', () => {
    expect(parseThbDecimalToSatang(parseThbDecimal('0'))).toBe(0n);
    expect(parseThbDecimalToSatang(parseThbDecimal('0.00'))).toBe(0n);
  });

  it('returns a branded Satang assignable to addSatang', () => {
    // Compile-time + runtime proof the brand survives.
    const a = parseThbDecimalToSatang(parseThbDecimal('100.00'));
    const b = parseThbDecimalToSatang(parseThbDecimal('0.07'));
    expect(addSatang(a, b)).toBe(10007n);
  });

  it('the parseThbDecimal CONSTRUCTOR rejects malformed input (RangeError)', () => {
    // The brand constructor is the FIRST validation gate — distinct from the
    // inline last-line guard in parseThbDecimalToSatang exercised below. A
    // raw/display string can never become a ThbDecimal without passing here.
    expect(() => parseThbDecimal('abc')).toThrow(RangeError);
    expect(() => parseThbDecimal('')).toThrow(RangeError);
    expect(() => parseThbDecimal('-1.00')).toThrow(RangeError);
    expect(() => parseThbDecimal('1.999')).toThrow(RangeError);
  });

  // The THROWS-on-malformed tests bypass the `parseThbDecimal`
  // constructor (which would itself throw at construction, before
  // `parseThbDecimalToSatang` ever runs) by casting a known-bad string
  // through `as ThbDecimal`. This exercises the retained inline
  // `VALID_THB_DECIMAL_RE` last-line guard inside `parseThbDecimalToSatang`
  // — the defence against a value that reached the parser through a
  // cast-through-the-brand.
  it('THROWS on a malformed input (3 fractional digits)', () => {
    expect(() =>
      parseThbDecimalToSatang('1.234' as ThbDecimal),
    ).toThrow(RangeError);
  });

  it('THROWS on a negative input', () => {
    expect(() =>
      parseThbDecimalToSatang('-1.00' as ThbDecimal),
    ).toThrow(RangeError);
  });

  it('THROWS on a non-numeric input', () => {
    expect(() => parseThbDecimalToSatang('abc' as ThbDecimal)).toThrow(
      RangeError,
    );
    expect(() => parseThbDecimalToSatang('' as ThbDecimal)).toThrow(RangeError);
  });
});
