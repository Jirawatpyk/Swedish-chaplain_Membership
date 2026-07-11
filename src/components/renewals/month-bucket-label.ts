/**
 * Renewals-by-month — pure presentation label helper + chart view item.
 *
 * `formatMonthKeyLabel` converts a `'YYYY-MM'` bucket key into a localized
 * "Month YYYY" label. For `th-TH` the year renders in the Buddhist Era via
 * `formatLocalisedDate`/`getDateFormatLocale` (`'th-TH-u-ca-buddhist'`) — the
 * calendar does the +543, so NEVER add a literal year or arithmetic (the
 * off-by-543 class of bug). `timeZone: 'UTC'` on a `-01T00:00:00Z` anchor
 * keeps the month stable across runtimes.
 */
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { UrgencyBucket } from '@/modules/renewals/client';

/** A single rendered bar (server-resolved, serialisable to the client chart). */
export interface MonthBarItem {
  readonly key: string;
  /** Full localized label — the accessible name ("December 2026" / "Overdue" / "July 2027 or later"). */
  readonly label: string;
  /** Compact axis label under the column ("Dec 26" / "ธ.ค. 69" / "Overdue" / "Jul 27+"). */
  readonly shortLabel: string;
  readonly count: number;
  readonly barPercent: number;
  readonly interactive: boolean;
  readonly band: UrgencyBucket;
}

/** Bucket-array position → representative urgency bucket, so the bar band reuses the pill palette.
 *  Order is [overdue, m0, m1, m2, m3…m11, later]:
 *  overdue→red(t-0) · current month→orange(t-7) · next 1-2 months→amber(t-14) · rest→slate(t-90). */
export function bandForBucketIndex(index: number): UrgencyBucket {
  if (index === 0) return 't-0';
  if (index === 1) return 't-7';
  if (index === 2 || index === 3) return 't-14';
  return 't-90';
}

export function formatMonthKeyLabel(monthKey: string, locale: string): string {
  return formatLocalisedDate(`${monthKey}-01T00:00:00Z`, locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Compact axis label for the vertical bar chart — abbreviated month + 2-digit
 * year (e.g. "Dec 26"). BE year for `th-TH` via the same calendar as
 * `formatMonthKeyLabel` (so "ธ.ค. 69" = 2569, never 2026).
 */
export function formatMonthKeyShort(monthKey: string, locale: string): string {
  return formatLocalisedDate(`${monthKey}-01T00:00:00Z`, locale, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
}
