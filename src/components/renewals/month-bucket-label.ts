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

/** A single rendered bar row (server-resolved, serialisable to the client chart). */
export interface MonthBarItem {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly barPercent: number;
  readonly interactive: boolean;
}

export function formatMonthKeyLabel(monthKey: string, locale: string): string {
  return formatLocalisedDate(`${monthKey}-01T00:00:00Z`, locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
