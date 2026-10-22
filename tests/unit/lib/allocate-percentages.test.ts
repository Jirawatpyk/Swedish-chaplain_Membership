/**
 * 124 slice 2 — the largest-remainder share allocation, extracted from the
 * home dashboard's invoice-status card so the invoice dashboard's aging card
 * reads the same rule (spec US1.3: shares add to 100; a non-zero share under
 * 1% reads `<1%`).
 */
import { describe, expect, it } from 'vitest';
import { allocatePercentages, formatSharePercentages } from '@/lib/allocate-percentages';

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('allocatePercentages', () => {
  it('three equal shares add to exactly 100, the leftover point to the first', () => {
    expect(allocatePercentages([1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('hands leftover points to the largest remainders', () => {
    // raw 12.5 / 37.5 / 50 → floors 12 / 37 / 50, one point left, tie → index 0
    expect(allocatePercentages([125, 375, 500])).toEqual([13, 37, 50]);
    // raw 66.67 / 33.33 → 67 / 33
    expect(allocatePercentages([2, 1])).toEqual([67, 33]);
  });

  it('always sums to 100 for five aging-style buckets', () => {
    const shares = allocatePercentages([123_456, 7, 98_765, 1, 50_000]);
    expect(sum(shares)).toBe(100);
  });

  it('a non-zero value under 1% allocates 0', () => {
    expect(allocatePercentages([1, 999])).toEqual([0, 100]);
  });

  it('all-zero input allocates all zeros', () => {
    expect(allocatePercentages([0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0]);
  });

  it('refuses a negative or non-finite value: all zeros', () => {
    expect(allocatePercentages([-100, 500, 0])).toEqual([0, 0, 0]);
    expect(allocatePercentages([Number.NaN, 1])).toEqual([0, 0]);
  });

  it('empty input gives an empty allocation', () => {
    expect(allocatePercentages([])).toEqual([]);
  });
});

describe('formatSharePercentages', () => {
  it('labels each share with a percent sign', () => {
    expect(formatSharePercentages([1, 1, 2])).toEqual(['25%', '25%', '50%']);
  });

  it('a non-zero share under 1% reads <1%, a zero share 0%', () => {
    expect(formatSharePercentages([1, 999, 0])).toEqual(['<1%', '100%', '0%']);
  });

  it('all-zero input reads 0% everywhere, never <1%', () => {
    expect(formatSharePercentages([0, 0])).toEqual(['0%', '0%']);
  });

  it('a refused (negative) allocation reads 0%, never <1%', () => {
    expect(formatSharePercentages([-100, 500, 0])).toEqual(['0%', '0%', '0%']);
  });
});
