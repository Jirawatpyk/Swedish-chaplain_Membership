/**
 * F119 T012 / T017 — WCAG 2.1 contrast helper (`domain/brand/contrast.ts`).
 *
 * FR-041b: a brand colour is refused when white text on it would not meet
 * WCAG AA (4.5:1). Pure arithmetic, no colour library (Constitution X).
 * Reference values come from the WCAG 2.1 relative-luminance formula:
 *   white  1.0 · black 0.0 · #10487a ≈ 0.061 (the platform default, ≈ 9.4:1)
 */
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  contrastRatioOnWhite,
  meetsAaOnWhiteText,
  relativeLuminance,
} from '@/modules/broadcasts/domain/brand/contrast';

describe('relativeLuminance', () => {
  it('is 1 for white and 0 for black', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
  });

  it('applies the sRGB linearisation (the 0.03928 knee, not a plain /255)', () => {
    // #808080 → 128/255 = 0.50196 → ((0.50196+0.055)/1.055)^2.4 = 0.2158
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2158, 3);
    // a very dark grey falls on the linear branch: 8/255 / 12.92
    expect(relativeLuminance('#080808')).toBeCloseTo(0.0024, 3);
  });

  it('accepts upper- and lower-case hex alike', () => {
    expect(relativeLuminance('#10487A')).toBeCloseTo(relativeLuminance('#10487a'), 10);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 between black and white in either order', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2);
  });

  it('is 1:1 for identical colours', () => {
    expect(contrastRatio('#10487a', '#10487a')).toBeCloseTo(1, 6);
  });
});

describe('meetsAaOnWhiteText (FR-041b — 4.5:1 against #ffffff)', () => {
  it('the platform default #10487a passes (≈ 9.4:1)', () => {
    expect(contrastRatioOnWhite('#10487a')).toBeGreaterThan(9);
    expect(meetsAaOnWhiteText('#10487a')).toBe(true);
  });

  it('`#f5f5f5` → ratio < 4.5, refused', () => {
    const ratio = contrastRatioOnWhite('#f5f5f5');
    expect(ratio).toBeLessThan(1.2);
    expect(meetsAaOnWhiteText('#f5f5f5')).toBe(false);
  });

  it('a mid orange just under the line is refused and one just over is accepted', () => {
    // #e07000 ≈ 3.2:1 (fails) · #b04a00 ≈ 6.4:1 (passes)
    expect(meetsAaOnWhiteText('#e07000')).toBe(false);
    expect(meetsAaOnWhiteText('#b04a00')).toBe(true);
  });

  it('returns a ratio truncated to two decimals for the refusal message', () => {
    const ratio = contrastRatioOnWhite('#f5f5f5');
    expect(ratio).toBe(Math.floor(ratio * 100) / 100);
  });

  // The display value is FLOORED, never rounded: #0080aa is ≈ 4.4986:1 raw,
  // which rounds UP to 4.5 — a readout that would claim the very threshold
  // the refusal says it misses ("{ ratio: 4.5, required: 4.5 }").
  it('`#0080aa` (≈ 4.4986 raw) is refused and displays 4.49, never 4.5', () => {
    expect(meetsAaOnWhiteText('#0080aa')).toBe(false);
    expect(contrastRatioOnWhite('#0080aa')).toBe(4.49);
  });
});

describe('input tolerance', () => {
  it('accepts the hex with or without the leading hash', () => {
    expect(relativeLuminance('ffffff')).toBeCloseTo(relativeLuminance('#ffffff'), 10);
  });
});
