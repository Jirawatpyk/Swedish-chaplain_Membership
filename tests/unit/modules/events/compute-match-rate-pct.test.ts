/**
 * Unit test for `computeMatchRatePct` — F6 Domain helper.
 *
 * Pins the rounding boundary cases that AS2 wire-format depends on
 * (Match rate header `"NN.N% (M of N)"` per
 * `specs/012-eventcreate-integration/spec.md` US2 AS2).
 *
 * H2 round-3 fix (2026-05-12): imports the REAL function from
 * `@/modules/events` Domain instead of re-deriving it locally. Both
 * `listEvents` + `loadEventDetail` use-cases consume the same helper.
 * A divergence in rounding mode (e.g., swap to `Math.floor`) now
 * breaks this test instead of silently rotting in the use-cases.
 */
import { describe, it, expect } from 'vitest';
import { computeMatchRatePct } from '@/modules/events/domain/match-rate';

describe('computeMatchRatePct — boundary table', () => {
  it.each([
    // [matched, total, expected, label]
    [0, 0, 0, 'zero-of-zero → 0 (no NaN)'],
    [0, 20, 0, 'zero-of-twenty → 0.0'],
    [18, 20, 90, 'AS2 example — 18 of 20 → 90.0'],
    [44, 47, 93.6, 'contract example — 44 of 47 → 93.6'],
    [1, 3, 33.3, '1/3 rounds to 33.3 (banker rounding edge)'],
    [2, 3, 66.7, '2/3 rounds to 66.7'],
    [1, 6, 16.7, '1/6 → 16.7 (16.666… rounds up at digit 1)'],
    [5, 6, 83.3, '5/6 → 83.3 (83.333… truncates effectively)'],
    [50, 100, 50, '50% even'],
    [99, 100, 99, '99% exact'],
    [100, 100, 100, '100% exact'],
    [1, 1000, 0.1, '0.1% edge — preserves single decimal'],
    [1, 10000, 0, '0.01% below resolution → 0'],
  ])('matched=%i total=%i → %f (%s)', (matched, total, expected) => {
    expect(computeMatchRatePct(matched, total)).toBe(expected);
  });

  it('handles total=0 without divide-by-zero', () => {
    expect(computeMatchRatePct(0, 0)).toBe(0);
    expect(computeMatchRatePct(5, 0)).toBe(0); // matched > 0 but total = 0
  });

  it('handles negative total gracefully (defensive)', () => {
    expect(computeMatchRatePct(5, -1)).toBe(0);
  });
});
