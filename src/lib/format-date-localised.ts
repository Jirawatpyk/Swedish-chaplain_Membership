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
 *
 * TIMEZONE DEFAULT (incident 2026-07-31 — prod React #418 hydration
 * mismatch on /admin/members + /admin/renewals): when the caller's
 * `options` carry no `timeZone`, `Intl.DateTimeFormat` formats in the
 * RUNTIME's zone — Vercel server = UTC, user browser = Asia/Bangkok —
 * so any 'use client' consumer rendered different SSR vs hydration
 * text. Default to `'Asia/Bangkok'`, matching the app-wide next-intl
 * pin (src/i18n/request.ts `timeZone: 'Asia/Bangkok'`) and the "BE
 * display-only, Bangkok wall-time" convention: output is now
 * independent of process/browser TZ. An EXPLICIT `options.timeZone`
 * still wins (e.g. month-bucket-label's deliberate UTC anchors).
 *
 * Note: date-ONLY ISO strings ('2026-07-30') were already safe either
 * way — they parse to UTC midnight = 7am Bangkok, the SAME calendar
 * day in both zones. Full timestamps were the hazard (hour always
 * differed; the day differed for instants ≥ 17:00 UTC).
 */
export function formatLocalisedDate(
  iso: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const withTz: Intl.DateTimeFormatOptions =
    options.timeZone !== undefined
      ? options
      : { ...options, timeZone: 'Asia/Bangkok' };
  return getFormatter(locale, withTz).format(d);
}
