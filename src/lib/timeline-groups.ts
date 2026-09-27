/**
 * Spec 122 US3 — the activity timeline's day groups and times, as on the
 * `Portal-timeline` boards: "Today", "This month", then one group per earlier
 * month ("July 2026"); a row shows its time only ("10:03") under Today and a
 * short date and time ("22 Sep, 14:10") elsewhere.
 *
 * Presentation only. Times are Asia/Bangkok, as `formatLocalisedTimestamp`
 * already shows them; Thai gets the Buddhist Era through
 * `getDateFormatLocale` (display only).
 */
import { getDateFormatLocale } from '@/lib/format-date-localised';

const TIME_ZONE = 'Asia/Bangkok';

/** `YYYY-MM-DD` in Bangkok, or null for text that is not a date. */
function bangkokDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export type TimelineGroup =
  | { readonly kind: 'today' }
  | { readonly kind: 'thisMonth' }
  /** An earlier month, `YYYY-MM` (Gregorian; the era is display only). */
  | { readonly kind: 'month'; readonly month: string };

/** The group an event falls in, relative to `now`; null for an unparseable timestamp. */
export function timelineGroup(iso: string, now: Date = new Date()): TimelineGroup | null {
  const day = bangkokDay(iso);
  const today = bangkokDay(now.toISOString());
  if (!day || !today) return null;
  if (day === today) return { kind: 'today' };
  if (day.slice(0, 7) === today.slice(0, 7)) return { kind: 'thisMonth' };
  return { kind: 'month', month: day.slice(0, 7) };
}

/** A stable key: consecutive events with the same key share a heading. */
export function timelineGroupKey(group: TimelineGroup | null): string {
  if (!group) return 'unknown';
  return group.kind === 'month' ? `month:${group.month}` : group.kind;
}

/** "July 2026" / "กรกฎาคม 2569" / "juli 2026" for an earlier month's heading. */
export function formatTimelineMonth(month: string, locale: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  // mid-month, noon UTC: the same month in every time zone
  const d = new Date(Date.UTC(y, m - 1, 15, 12));
  return new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    month: 'long',
    year: 'numeric',
    timeZone: TIME_ZONE,
  }).format(d);
}

/** "10:03" when `timeOnly` (the Today group), else "22 Sep, 14:10". */
export function formatTimelineTime(iso: string, locale: string, timeOnly: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    ...(timeOnly ? {} : { day: 'numeric', month: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIME_ZONE,
  }).format(d);
}
