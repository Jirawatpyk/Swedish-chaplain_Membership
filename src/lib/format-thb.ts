/**
 * Cross-module satang → currency display formatter (review 2026-04-26
 * simplify R3).
 *
 * Promoted from `src/app/(member)/portal/invoices/_utils/format.ts`
 * — was originally portal-scoped because F4 was the first consumer,
 * but `format-payment-summary.ts:11-17` already documented that
 * `formatSatangThb` is the canonical THB formatter. F5 admin refund
 * surface (`refund-form.tsx`, `RefundDialog`) is the first cross-
 * module caller, so the helper now lives at `src/lib/` where any
 * module can depend on it without crossing route-group boundaries.
 *
 * The signature is BACK-COMPAT with the original portal callers:
 * `currency` defaults to `'THB'`, output stays `"<amount> <CURRENCY>"`
 * (suffix style — NOT `Intl.NumberFormat({style:'currency'})`, which
 * would produce a different shape per locale and break the existing
 * portal text). The 7 portal call sites + the F5 refund form all
 * pass through this single function.
 */

const FORMATTERS = new Map<string, Intl.NumberFormat>();

/**
 * Format a satang amount as a localised major-unit string with a
 * currency suffix. Handles negative values (credit-note totals)
 * with an explicit sign prefix — the previous implementation
 * produced `0.-34 THB` because `-3434n % 100n` is `-34n` in BigInt
 * arithmetic, which `.padStart` printed verbatim.
 *
 * Returns `'—'` for null inputs so missing monetary fields read
 * cleanly in table cells.
 *
 * @param satang   Amount in satang (1 THB = 100 satang). NULL → `'—'`.
 * @param locale   BCP-47 locale tag for thousands grouping (default `'en-US'`).
 * @param currency ISO-4217 currency code, used as the suffix (default `'THB'`).
 */
export function formatSatangThb(
  satang: bigint | null,
  locale: string = 'en-US',
  currency: string = 'THB',
): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  let fmt = FORMATTERS.get(locale);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { useGrouping: true });
    FORMATTERS.set(locale, fmt);
  }
  return `${sign}${fmt.format(whole)}.${rem.toString().padStart(2, '0')} ${currency}`;
}
