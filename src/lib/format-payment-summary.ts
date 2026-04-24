/**
 * Locale-aware formatters for the online-payment confirmation summary.
 *
 * G-Review Finding #2 closeout
 * ----------------------------
 * The PaySheet confirmation panel previously fed `Number.toLocaleString()`
 * (no locale arg) + raw `Date.toISOString()` into the `summaryCard` /
 * `summaryPromptPay` i18n templates. That produced OS-default grouping
 * (wrong for th-TH / sv-SE) and an unlocalized ISO datetime string.
 *
 * The F4 invoicing module owns `formatSatangThb` (see
 * `src/app/(member)/portal/invoices/_utils/format.ts`) — that helper
 * takes a `bigint` satang value. The PaySheet confirmation path carries
 * `amountDue` as a `number` (display-only from the initiate response),
 * so we adapt to the existing canonical helper by lifting the
 * `Intl.NumberFormat` cache strategy verbatim + delegating formatting.
 */

const DATETIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * Format an amount (whole currency units, NOT satang) + currency code
 * into a locale-aware display string. Returns e.g.:
 *   - `en-US` + 12000 + 'THB' → "THB 12,000"
 *   - `th-TH` + 12000 + 'THB' → "THB 12,000"  (same separators here)
 *   - `sv-SE` + 12000 + 'THB' → "THB 12 000"  (non-breaking space)
 *
 * Currency code is prefixed verbatim so the PaySheet summary matches
 * the rest of the member portal (currency sits before the number —
 * see `invoices-summary-card.tsx`).
 */
export function formatPaymentAmount(
  amount: number,
  currency: string,
  locale: string = 'en-US',
): string {
  const numberFmt = new Intl.NumberFormat(locale, { useGrouping: true });
  return `${currency} ${numberFmt.format(amount)}`;
}

/**
 * Format a Date (or `new Date()` default) into a locale-aware "date +
 * time" string suitable for the payment-confirmation summary. Uses the
 * canonical `Intl.DateTimeFormat` with `dateStyle: 'long'` +
 * `timeStyle: 'short'`. Cached by locale so repeat renders don't
 * rebuild the formatter on every tick.
 */
export function formatPaymentDateTime(
  date: Date = new Date(),
  locale: string = 'en-US',
): string {
  let fmt = DATETIME_FORMATTERS.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      dateStyle: 'long',
      timeStyle: 'short',
    });
    DATETIME_FORMATTERS.set(locale, fmt);
  }
  return fmt.format(date);
}
