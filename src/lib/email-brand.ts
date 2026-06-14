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

/**
 * Absolute URL of the brand logo PNG used in the transactional-email header.
 *
 * Email clients (Gmail, Outlook, Apple Mail) cannot render SVG and will not
 * load app-relative paths, so the logo MUST be an absolute https URL pointing
 * at the hosted PNG under `public/brand/`.
 *
 * Read directly from `process.env.APP_BASE_URL` (NOT the validated `env`
 * object) so that rendering a template in a unit test — where APP_BASE_URL
 * may be unset — degrades to an app-relative path instead of throwing at
 * module load. Production always has APP_BASE_URL set (validated at boot by
 * `src/lib/env.ts`), so real emails always get a fully-qualified URL.
 */
export function emailLogoUrl(): string {
  const base = (process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');
  return `${base}/brand/swecham-email-logo.png`;
}
