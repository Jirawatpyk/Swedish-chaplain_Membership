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
 * locale string.
 *
 * - `'th'` / `'th-TH'` → `'th-TH-u-ca-buddhist'` (Buddhist Era calendar, +543)
 * - `'sv'` / `'sv-SE'` → `'sv-SE'` (ensures canonical BCP-47 region tag)
 * - All other locales pass through unchanged.
 */
export function getDateFormatLocale(locale: string): string {
  if (locale === 'th' || locale === 'th-TH') {
    return 'th-TH-u-ca-buddhist';
  }
  if (locale === 'sv' || locale === 'sv-SE') {
    return 'sv-SE';
  }
  return locale;
}

/**
 * `Intl.DateTimeFormat` construction (locale/calendar negotiation) is the
 * expensive part of formatting — the `.format()` call is cheap. Callers that
 * format many dates with the same (locale, options) pair per render (e.g. the
 * renewals-by-month chart formats ~13 buckets twice: long + short label) would
 * otherwise build a fresh formatter each time. Memoise by resolved-locale +
 * options so each distinct pair constructs its formatter once per process.
 * Formatters are immutable + stateless (no per-request/tenant data), so sharing
 * across requests is safe; the key space is tiny (few locales × few option
 * shapes) so the map stays small without eviction.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const resolvedLocale = getDateFormatLocale(locale);
  const key = `${resolvedLocale}|${JSON.stringify(options)}`;
  let fmt = formatterCache.get(key);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat(resolvedLocale, options);
    formatterCache.set(key, fmt);
  }
  return fmt;
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
  return getFormatter(locale, options).format(d);
}
