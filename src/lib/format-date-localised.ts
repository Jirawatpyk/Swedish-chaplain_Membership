/**
 * Locale-aware date formatting helpers.
 *
 * Simp#4 round-3 fix (2026-05-12): extracted from F6 components
 * (`events-list-table`, `event-detail-header`, `attendee-table`) where
 * the same Thai BE-display branch was duplicated three times. This
 * helper centralises the Thai locale → Buddhist-Era calendar mapping
 * per CLAUDE.md § Conventions ("BE display-only on th-TH surfaces;
 * storage stays UTC Gregorian").
 *
 * Future F7/F8 Thai-display surfaces should consume this helper to
 * keep the BE-vs-Gregorian invariant in a single place.
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
