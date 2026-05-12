/**
 * Locale-aware date formatting helpers.
 *
 * Centralises the Thai locale → Buddhist-Era calendar mapping per
 * CLAUDE.md § Conventions: "BE display-only on th-TH surfaces;
 * storage stays UTC Gregorian". Any new Thai-display surface should
 * consume `formatLocalisedDate` (or `getDateFormatLocale` for the
 * lower-level locale string) instead of inlining the
 * `'th-TH-u-ca-buddhist'` calendar variant.
 */

/**
 * Map a next-intl locale to the appropriate `Intl.DateTimeFormat`
 * locale string. For `'th'` / `'th-TH'` returns
 * `'th-TH-u-ca-buddhist'` so display renders BE year (+543). All
 * other locales pass through unchanged.
 */
export function getDateFormatLocale(locale: string): string {
  if (locale === 'th' || locale === 'th-TH') {
    return 'th-TH-u-ca-buddhist';
  }
  return locale;
}

/**
 * Convenience: format an ISO timestamp with locale-aware calendar.
 * Returns `'—'` for invalid dates (em-dash, NOT empty string, so
 * the UI can render a stable layout).
 */
export function formatLocalisedDate(
  iso: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(getDateFormatLocale(locale), options).format(d);
}
