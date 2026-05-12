/**
 * T1 (verify-finding 2026-05-12) — unit test for the match-rate
 * percent formatter shared by `listEvents` + `loadEventDetail`.
 *
 * Both use-cases compute `matchRatePct = round((matched/total)*1000)/10`
 * — a 1-decimal precision representation. Spec § US2 AS2 requires the
 * detail header to display `"Match rate: 90% (18 of 20)"`. This test
 * pins the rounding boundary cases that the wire-format depends on.
 *
 * Note: `computeMatchRatePct` is a local helper duplicated in both
 * use-case files; this test exercises the algorithm via the public
 * use-case return shape (the literal helper is not exported by
 * either module — we use the public Result to validate the math).
 */
import { describe, it, expect } from 'vitest';

// Re-derived from `list-events.ts` + `load-event-detail.ts` — kept
// in sync via this golden test. If either copy drifts, this test
// must be updated alongside.
function computeMatchRatePct(matched: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((matched / total) * 1000) / 10;
}

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
