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

import { buildFormats, type DateTimePresetKey } from '@/i18n/formats';

/**
 * Map a next-intl locale to the appropriate `Intl.DateTimeFormat`
 * locale string.
 *
 * - `'th'` / `'th-TH'` → `'th-TH-u-ca-buddhist'` (Buddhist Era calendar, +543)
 * - `'sv'` / `'sv-SE'` → `'sv-SE'` (ensures canonical BCP-47 region tag)
 * - `'en'` / `'en-US'` → `'en-GB'` (docs/ux-standards.md § 12.3 — English
 *   dates read day-first, 24-hour: "23 Sept 2026, 14:10", not the en-US
 *   "Sep 23, 2026, 02:10 PM")
 * - All other locales pass through unchanged.
 */
export function getDateFormatLocale(locale: string): string {
  if (locale === 'th' || locale === 'th-TH') {
    return 'th-TH-u-ca-buddhist';
  }
  if (locale === 'sv' || locale === 'sv-SE') {
    return 'sv-SE';
  }
  if (locale === 'en' || locale === 'en-US') {
    return 'en-GB';
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
  iso: string | Date,
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

/**
 * A bare calendar YEAR for display: `2026` in en/sv, `2569` in th (Buddhist
 * Era — CLAUDE.md § Conventions: BE is display-only, storage stays CE/UTC).
 *
 * Portal live walk U30 (2026-09-22): the member quota surface interpolated
 * `{year}` as a raw CE integer in four places while interpolating `{date}`
 * through a formatter one line away, so the Thai card printed
 * "โควตา E-Blast (2026)" directly above "รีเซ็ตโควตา 1 มกราคม 2570" with
 * "22 ก.ย. 2569" in the table below — three calendars on one screen. Any
 * surface that prints a year beside a formatted date must send it through
 * here.
 *
 * The era prefix is dropped: `th-TH-u-ca-buddhist` renders `{year:'numeric'}`
 * as "พ.ศ. 2569", which reads wrong inside copy that already says "ของปี".
 * `formatToParts` gives the digits alone, in the locale's own numbering.
 *
 * The instant is mid-year UTC on purpose: every tenant timezone offset lands
 * inside the same calendar year, so this never depends on the runtime zone.
 */
export function formatCalendarYear(year: number, locale: string): string {
  // Only a plausible four-digit CE year is converted. A partial value typed
  // into a year input ("2", "20", "202") echoes back verbatim: `Date.UTC`
  // maps 0–99 to 1900+, and BE-shifting "202" to "745" would mislead.
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return String(year);
  const midYear = new Date(Date.UTC(year, 6, 1));
  const parts = getFormatter(locale, { year: 'numeric' }).formatToParts(midYear);
  return parts.find((p) => p.type === 'year')?.value ?? String(year);
}

/**
 * Render one of the named next-intl dateTime presets (`src/i18n/formats.ts`)
 * through this helper instead of next-intl's `format.dateTime(d, preset)`.
 *
 * next-intl formats with the raw request locale, so English came out en-US
 * ("Sep 23, 2026, 02:10 PM") next to this helper's en-GB ("23 Sept 2026") on
 * the same screen. A preset cannot change the locale, so the presets are
 * rendered here: `getDateFormatLocale` (en → en-GB, th → Buddhist calendar),
 * Bangkok wall time, and a 24-hour clock whenever the preset shows a time
 * (docs/ux-standards.md § 12.3). `scripts/check-dates.ts` bans `.dateTime(`.
 *
 * Returns `'—'` for an invalid date, like {@link formatLocalisedDate}.
 */
export function formatDatePreset(
  value: string | Date,
  locale: string,
  preset: DateTimePresetKey,
): string {
  const presetLocale = locale.startsWith('th') ? 'th' : locale.startsWith('sv') ? 'sv' : 'en';
  const options: Intl.DateTimeFormatOptions = { ...buildFormats(presetLocale).dateTime[preset] };
  if ('hour' in options || 'timeStyle' in options) options.hourCycle = 'h23';
  return formatLocalisedDate(value, locale, options);
}

/**
 * Hours + minutes on a 24-hour clock — the "Saved at 14:10" labels. Pass to
 * {@link formatLocalisedDate}.
 */
export const TIME_HH_MM: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};
