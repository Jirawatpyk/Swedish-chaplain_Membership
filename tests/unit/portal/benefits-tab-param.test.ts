import { describe, expect, it } from 'vitest';
import {
  resolveBenefitsTab,
  clampBenefitsPage,
  BENEFITS_TAB,
} from '@/app/(member)/portal/benefits/_helpers/tabs';

describe('resolveBenefitsTab (058 G1)', () => {
  it('defaults to benefits when param is absent', () => {
    expect(resolveBenefitsTab(undefined)).toBe(BENEFITS_TAB.benefits);
  });

  it('returns broadcasts when param is "broadcasts"', () => {
    expect(resolveBenefitsTab('broadcasts')).toBe(BENEFITS_TAB.broadcasts);
  });

  it('returns benefits when param is "benefits"', () => {
    expect(resolveBenefitsTab('benefits')).toBe(BENEFITS_TAB.benefits);
  });

  it('clamps an unknown value to the default benefits tab', () => {
    expect(resolveBenefitsTab('garbage')).toBe(BENEFITS_TAB.benefits);
  });

  // S-resolveBenefitsTab-unknown — the signature widened to `unknown` so the
  // helper is the single canonical clamp for BOTH Next searchParams
  // (`string | string[] | undefined`) and the Base UI Tabs `onValueChange`
  // value (typed `any`). Non-string inputs must clamp to benefits, NOT throw.
  it('clamps a string[] (repeated ?tab=) to benefits', () => {
    expect(resolveBenefitsTab(['broadcasts'])).toBe(BENEFITS_TAB.benefits);
  });

  it('clamps a number to benefits', () => {
    expect(resolveBenefitsTab(0)).toBe(BENEFITS_TAB.benefits);
  });

  it('clamps null to benefits', () => {
    expect(resolveBenefitsTab(null)).toBe(BENEFITS_TAB.benefits);
  });

  it('clamps an object to benefits', () => {
    expect(resolveBenefitsTab({})).toBe(BENEFITS_TAB.benefits);
  });
});

// I5 — the `?page=` clamp was extracted from page.tsx into `clampBenefitsPage`
// so the bound is unit-tested without rendering and is the single source of
// truth for the [1, 1000] page integer. Bounds confirmed against the former
// inline `Math.min(1_000, Math.max(1, Number(page ?? '1') || 1))`.
describe('clampBenefitsPage (058 G1 / I5)', () => {
  // Boundary table — lower bound, upper bound, and the values that previously
  // lived inline in page.tsx.
  const inBoundsCases: ReadonlyArray<readonly [unknown, number, string]> = [
    [-5, 1, 'negative clamps to the lower bound'],
    [0, 1, 'zero clamps to the lower bound'],
    [1, 1, 'the lower bound is preserved'],
    [1000, 1000, 'the upper bound is preserved'],
    [99999, 1000, 'above the upper bound clamps down'],
    ['5', 5, 'a numeric string parses'],
    ['1000', 1000, 'a numeric string at the upper bound parses'],
    [2.9, 2, 'a fractional floors (never rounds up)'],
    [1.999, 1, 'a fractional just under 2 floors to 1'],
  ];
  it.each(inBoundsCases)('clampBenefitsPage(%o) → %i (%s)', (raw, expected) => {
    expect(clampBenefitsPage(raw)).toBe(expected);
  });

  // Invalid / non-finite / missing inputs (Number(raw) is NaN or non-finite)
  // all fall back to the lower bound (1).
  const fallbackCases: ReadonlyArray<readonly [unknown, string]> = [
    ['abc', 'a non-numeric string'],
    ['', 'an empty string'],
    [undefined, 'undefined (missing param)'],
    [null, 'null'],
    [NaN, 'NaN'],
    [Infinity, 'positive infinity'],
    [-Infinity, 'negative infinity'],
    [{}, 'an object'],
    [['a', 'b'], 'a multi-element array (Number → NaN)'],
  ];
  it.each(fallbackCases)('clampBenefitsPage(%o) → 1 (%s)', (raw) => {
    expect(clampBenefitsPage(raw)).toBe(1);
  });

  // JS quirk: Number(['5']) === 5, so a single-element numeric array coerces to
  // an in-range page rather than NaN. We tolerate it (still safely in [1, 1000])
  // because the page.tsx searchParams reader never yields a single-element
  // array for a scalar `?page=` — documenting the boundary so it isn't mistaken
  // for a clamp bug later.
  it('tolerates Number-coercible single-element arrays (in-range, never out of bounds)', () => {
    const result = clampBenefitsPage(['5']);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(1000);
    expect(result).toBe(5);
  });
});
