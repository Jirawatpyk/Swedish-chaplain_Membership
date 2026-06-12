/**
 * Brand primary colour for transactional + broadcast emails — the app's
 * `--primary` token value (deep Swedish navy). Kept as an inline literal
 * because email clients don't resolve CSS variables; it is inlined into the
 * rendered HTML at build/render time.
 *
 * White text on this navy is ≈ 9.4:1 (WCAG 2.1 AA, well above 4.5:1).
 *
 * Single source of truth: update here when the brand navy changes and every
 * email CTA button / heading stays in sync (was previously hardcoded inline
 * across ~5 email builders, with one casing drift `#10487A`/`#10487a`).
 */
export const EMAIL_BRAND_PRIMARY = '#10487a';
