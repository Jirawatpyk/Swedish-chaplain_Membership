/**
 * Locale-aware relative-time formatter.
 *
 * Uses the native `Intl.RelativeTimeFormat` API (supported by all
 * target browsers + Node 22). No external library needed.
 *
 * Output examples:
 *   - EN: "5 minutes ago", "2 days ago", "3 months ago"
 *   - TH: "5 นาทีที่ผ่านมา", "2 วันที่ผ่านมา"
 *   - SV: "för 5 minuter sedan", "för 2 dagar sedan"
 *
 * For timestamps older than 30 days, falls back to an absolute
 * formatted date (e.g. "Apr 10, 2026") — because "87 days ago" is
 * harder to parse than a calendar date.
 *
 * The `locale` parameter should be a BCP47 tag that `Intl` supports:
 * 'en', 'th', 'sv', etc. Thai Buddhist Era is NOT applied here — it
 * belongs in the absolute formatter (timeline-event-item.tsx) which
 * uses `th-TH-u-ca-buddhist`. Relative time ("2 วันที่ผ่านมา") is
 * calendar-agnostic.
 */

import { getDateFormatLocale } from '@/lib/format-date-localised';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH_APPROX = 30 * DAY;

type Unit = 'second' | 'minute' | 'hour' | 'day' | 'month';

const THRESHOLDS: Array<[number, Unit, number]> = [
  [MINUTE, 'second', SECOND],
  [HOUR, 'minute', MINUTE],
  [DAY, 'hour', HOUR],
  [MONTH_APPROX, 'day', DAY],
];

/**
 * Format an ISO 8601 timestamp as a relative string ("5 minutes ago")
 * when recent (< 30 days), or as an absolute short date when older.
 *
 * `now` is injectable for deterministic tests. `timeZone` (optional) is applied
 * ONLY to the >30-day absolute-date fallback — the relative branches are
 * tz-agnostic. Pass the tenant timezone so an old event near the tenant's
 * midnight boundary shows the correct calendar day, not the UTC runtime day.
 */
export function formatRelativeTime(
  iso: string,
  locale: string,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const diffMs = now.getTime() - date.getTime();

  // Future dates or "just now" → "just now" / "เมื่อสักครู่" / "nyss"
  if (diffMs < 10 * SECOND) {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      0,
      'second',
    );
  }

  // Find the right unit
  for (const [threshold, unit, divisor] of THRESHOLDS) {
    if (diffMs < threshold) {
      const value = -Math.floor(diffMs / divisor);
      return new Intl.RelativeTimeFormat(locale, {
        numeric: 'auto',
      }).format(value, unit);
    }
  }

  // Older than ~30 days → absolute formatted date
  try {
    return new Intl.DateTimeFormat(getDateFormatLocale(locale), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}
