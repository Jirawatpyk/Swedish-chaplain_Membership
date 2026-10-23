/**
 * 124 — display helpers shared by the dashboard's cards. Amounts use the
 * invoicing surfaces' one formatter (`formatSatangThb`, `en-US` grouping, so a
 * figure reads exactly as the invoice list it links to does); dates and years
 * go through the localised formatters (Buddhist year on `th`, display only).
 */
import { formatSatangThb } from '@/lib/format-thb';
import { formatCalendarYear, formatLocalisedDate } from '@/lib/format-date-localised';

/** "1,102,560.00 THB" — the card rows' and footers' amount. */
export function formatAmount(satang: bigint): string {
  return formatSatangThb(satang, 'en-US');
}

/** Satang as whole-baht display units for `CountUp` (it never takes satang). */
export function toBaht(satang: bigint): number {
  return Number(satang) / 100;
}

/** A `YYYY-MM-DD` calendar date in the locale's own form (a date-only string is the same day in Bangkok). */
export function formatDay(isoDate: string, locale: string): string {
  return formatLocalisedDate(isoDate, locale, { dateStyle: 'medium' });
}

export function formatMonthShort(isoDate: string, locale: string): string {
  return formatLocalisedDate(isoDate, locale, { month: 'short' });
}

export function formatMonthLong(isoDate: string, locale: string): string {
  return formatLocalisedDate(isoDate, locale, { month: 'long' });
}

/** "October 2026" ("ตุลาคม 2569" on th). */
export function formatMonthYear(isoDate: string, locale: string): string {
  return formatLocalisedDate(isoDate, locale, { month: 'long', year: 'numeric' });
}

export function formatYear(year: number, locale: string): string {
  return formatCalendarYear(year, locale);
}
