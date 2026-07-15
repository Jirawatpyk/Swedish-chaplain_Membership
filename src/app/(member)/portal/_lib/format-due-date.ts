import { getDateFormatLocale } from '@/lib/format-date-localised';

/**
 * Format a `YYYY-MM-DD` invoice due date for display. Extracted (059-
 * membership-suspension) from `outstanding-stat-section.tsx` so the
 * membership-stat card's suspended copy ("Invoice due {dueDate}") uses the
 * identical formatting the Outstanding-balance card already uses — a single
 * source of truth for "what a due date looks like" on the portal dashboard.
 *
 * Display-only BE date for th-TH via `getDateFormatLocale` — storage stays
 * UTC Gregorian (Constitution Conventions § Timestamps).
 */
export function formatDueDate(ymd: string, locale: string): string {
  return new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString(
    getDateFormatLocale(locale),
    { year: 'numeric', month: 'short', day: 'numeric' },
  );
}
