/**
 * Shared presentation utilities for the member-portal invoice surfaces.
 *
 * Extracted during /speckit.fixit.run (2026-04-20) to close a review
 * Critical + Important pair:
 *   - C1: `formatSatangThb` in `invoices-summary-card.tsx` did NOT
 *         handle negative satang (credit note totals) — the detail
 *         page had an `abs` branch that the summary card copy lost.
 *   - I1: `formatSatangThb` + `formatDate` + the status styling
 *         lived in three places (list page, detail page, summary
 *         card) — Reusable Components principle (CLAUDE.md global
 *         instructions + Constitution § Code Quality).
 *
 * Single source of truth: editing this file updates every portal
 * invoice surface at once. THB currency formatting uses
 * `Intl.NumberFormat` so SV / TH / EN locales format thousands
 * separators correctly (UX Sugg #7).
 */

// `formatSatangThb` moved to `src/lib/format-thb.ts` (simplify R3,
// 2026-04-26) so cross-module callers (F5 admin refund surface)
// don't cross route-group boundaries. Re-exported here so existing
// portal callers don't break — staged migration; portal imports
// will update to the canonical lib path in a follow-up.
export { formatSatangThb } from '@/lib/format-thb';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { InvoiceStatus } from '@/modules/invoicing';
import type { StatusTone } from '@jirawatpyk/aura-react/server';

/**
 * Presentation status surfaced to an invoice row/badge — the stored
 * {@link InvoiceStatus} widened with the derived `'overdue'` value
 * (T109 / FR-028). `'overdue'` is presentation-only; the stored status is
 * never `'overdue'`. Defined here (the leaf presentation util) so the
 * status-helper params below can be tied to the union, and re-exported
 * from `invoice-row-view-model.ts` (which builds `displayStatus`) so its
 * public surface is unchanged. Single source of truth for the row status
 * vocabulary — passing a stale/typo status to a helper is a COMPILE error.
 */
export type InvoiceRowDisplayStatus = InvoiceStatus | 'overdue';

/**
 * Medium-style date formatter tolerant of null inputs. Routes the locale
 * through `getDateFormatLocale` so Thai renders the Buddhist-Era year
 * explicitly (`-u-ca-buddhist`) rather than depending on the host ICU build's
 * default calendar for the bare `th` locale (display-only; storage is UTC
 * Gregorian).
 */
export function formatDate(iso: string | null, locale: string): string {
  return formatLocalisedDate(iso ?? '', locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * The VAT rate snapshotted on an invoice (`VatRate.raw`, always `x.xxxx`)
 * as a locale number of percent points: "0.0700" → "7", "0.0750" → "7.5"
 * (SV "7,5"). Integer maths on the 4-dp string, so no float drift. The
 * `Invoice-paid` board reads "VAT 7%"; a §80/1(5) zero-rated invoice reads
 * its own 0, so the rate always comes from the invoice, never a constant.
 */
export function formatVatRatePoints(raw: string, locale: string): string {
  const basisPoints = Number(raw.replace('.', ''));
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(basisPoints / 100);
}

/**
 * An invoice line's quantity for display. It is stored as a 4-dp numeric
 * ("1.0000"), so it reads "1", "2.5" (SV "2,5"). Display only: the line total
 * is computed and stored upstream, never from this string.
 */
export function formatLineQuantity(quantity: string, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(Number(quantity));
}

/**
 * The AURA status-pill tone per invoice status (spec 122 US4, `Invoices`
 * board): paid ready, issued in progress, overdue blocked, and the rest
 * (void, draft, credited) neutral. The pill carries its own icon beside the
 * word, so colour is never the only signal.
 */
export function invoiceStatusTone(status: InvoiceRowDisplayStatus): StatusTone {
  switch (status) {
    case 'paid':
      return 'ready';
    case 'issued':
      return 'progress';
    case 'overdue':
      return 'blocked';
    default:
      return 'neutral';
  }
}
