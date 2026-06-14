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
 *
 * This hex is a MANUALLY-maintained sRGB equivalent of the app's `--primary`
 * OKLCH token (`oklch(0.3947 0.1012 250.40)` at `src/app/globals.css` ~line
 * 144). Email clients can't resolve CSS variables OR `oklch()`, so the value
 * is duplicated here as a static hex — keep the two in sync by hand when the
 * brand navy changes, or the documented ≈9.4:1 contrast figure above can
 * silently drift from the in-app token (S15 speckit-review).
 */
export const EMAIL_BRAND_PRIMARY = '#10487a' as const;
