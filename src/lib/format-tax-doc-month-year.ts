/**
 * Thai tax-document MONTH-YEAR formatter — the month+year variant of
 * `format-tax-doc-date.ts`, used on the §86/4 membership line's coverage window
 * ("August 2026 - July 2027" / "สิงหาคม 2569 - กรกฎาคม 2570").
 *
 * Renders the full month name + year: Gregorian for en/sv, Thai month + Buddhist
 * Era (CE + 543) for th. Same guards as `format-tax-doc-date.ts`:
 *   - input is a bare `YYYY-MM-DD` → parsed via `Date.UTC` + rendered with
 *     `timeZone: 'UTC'` so the month never shifts across server-UTC vs
 *     Asia/Bangkok;
 *   - the CE base is FORCED to the Gregorian calendar (`'th-TH-u-ca-gregory'`) so
 *     the BE year can never double-print on an ICU build whose bare-`'th'` default
 *     calendar is buddhist.
 * BE is display-only; storage stays UTC Gregorian (CLAUDE.md).
 */
import { getDateFormatLocale } from '@/lib/format-date-localised';

export function formatTaxDocMonthYear(isoDate: string, locale: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (
    Number.isNaN(year) || year < 1 ||
    Number.isNaN(month) || month < 1 || month > 12 ||
    Number.isNaN(day) || day < 1 || day > 31
  ) return '—';

  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) return '—';

  const isThai = locale === 'th' || locale === 'th-TH';
  // Format ONLY the month name via Intl, then append the year as a plain integer.
  // This side-steps the number-SYSTEM question entirely (Thai locales can render
  // Gregorian years in Thai digits) — the year is always Latin digits, and the
  // Thai year is its Buddhist-Era value (CE + 543), inline. BE is display-only.
  const monthName = d.toLocaleDateString(
    isThai ? 'th-TH-u-ca-gregory' : getDateFormatLocale(locale),
    { month: 'long', timeZone: 'UTC' },
  );
  return `${monthName} ${isThai ? year + 543 : year}`;
}
