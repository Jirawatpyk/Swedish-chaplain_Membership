/**
 * next-intl locale configuration.
 *
 * Three locales per Constitution Principle V and spec FR-014:
 *   - en: canonical source of truth + fallback (missing key in en FAILS build)
 *   - th: mandatory for Thai tax surfaces (F4); fallback to en in dev
 *   - sv: co-official for Swedish chamber audience; fallback to en in dev
 *
 * At release, docs/ux-standards.md § 12 is stricter: all three must be
 * present. The check:i18n script (scripts/check-i18n-coverage.ts) enforces
 * this precedence.
 */

export const locales = ['en', 'th', 'sv'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

export const localeLabels: Record<Locale, string> = {
  en: 'English',
  th: 'ไทย',
  sv: 'Svenska',
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

/**
 * Name of the cookie next-intl reads for the active locale (see request.ts).
 * Shared by the read side (request.ts) and the write side (LocaleSwitcher) so
 * the two can never drift.
 */
export const LOCALE_COOKIE_NAME = 'NEXT_LOCALE';
