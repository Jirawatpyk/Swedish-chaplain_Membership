/**
 * Thai tax-document date formatter (credit-notes; matches the invoice
 * PDF intent). Renders `CE + (พ.ศ. year+543)` for `th`, Gregorian-only
 * for en/sv. Distinct from the GENERAL `formatLocalisedDate` because:
 *   - input is a bare `YYYY-MM-DD` (not an ISO timestamp) → parsed via
 *     `Date.UTC` + rendered with `timeZone: 'UTC'` so the day never
 *     shifts across server-UTC vs Asia/Bangkok;
 *   - the CE base is FORCED to the Gregorian calendar
 *     (`'th-TH-u-ca-gregory'`) so the BE year can never double-print
 *     ("29 พ.ค. 2569 (พ.ศ. 2569)") on an ICU build whose bare-`'th'`
 *     default calendar is buddhist.
 * BE is display-only; storage stays UTC Gregorian (CLAUDE.md).
 */
import { getDateFormatLocale } from '@/lib/format-date-localised';

export function formatTaxDocDate(isoDate: string, locale: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  // R4: reject NaN, falsy-zero-safe bounds check, out-of-range values → em-dash
  if (
    Number.isNaN(year) || year < 1 ||
    Number.isNaN(month) || month < 1 || month > 12 ||
    Number.isNaN(day) || day < 1 || day > 31
  ) return '—';

  const isThai = locale === 'th' || locale === 'th-TH';
  // R3: non-Thai locales route through getDateFormatLocale (e.g. 'sv' → 'sv-SE')
  const ce = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(
    isThai ? 'th-TH-u-ca-gregory' : getDateFormatLocale(locale),
    { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' },
  );
  return isThai ? `${ce} (พ.ศ. ${year + 543})` : ce;
}
