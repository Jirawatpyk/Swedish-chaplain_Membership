/**
 * F119 T017 — WCAG 2.1 relative luminance + contrast ratio (FR-041b).
 *
 * Pure Domain arithmetic — no colour library (Constitution X). A brand
 * colour is refused when white text on it would not meet AA (4.5:1); the
 * computed ratio is returned so the refusal can say why.
 *
 * Formulas: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance and
 * #dfn-contrast-ratio. Input is `#RRGGBB` (any case); the format itself is
 * validated by `parseBrandPrimaryColor` before this is called.
 */

export const AA_MIN_CONTRAST = 4.5;

function channel(hex: string, offset: number): number {
  const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Ratio of `hex` against `#ffffff`, for DISPLAY only — FLOORED to two
 * decimals, never rounded, so a readout can never claim a threshold the raw
 * ratio misses (#0080aa is ≈ 4.4986 raw: rounded it read "4.5"). Decisions
 * use `meetsAaOnWhiteText`, which compares the raw ratio.
 */
export function contrastRatioOnWhite(hex: string): number {
  return Math.floor(contrastRatio(hex, '#ffffff') * 100) / 100;
}

/** THE AA decision — raw ratio, server and client alike. */
export function meetsAaOnWhiteText(hex: string): boolean {
  return contrastRatio(hex, '#ffffff') >= AA_MIN_CONTRAST;
}
