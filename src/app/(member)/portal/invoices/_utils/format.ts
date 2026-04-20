/**
 * Shared presentation utilities for the member-portal invoice surfaces.
 *
 * Extracted during /speckit.fixit.run (2026-04-20) to close a review
 * Critical + Important pair:
 *   - C1: `formatSatangThb` in `invoices-summary-card.tsx` did NOT
 *         handle negative satang (credit note totals) — the detail
 *         page had an `abs` branch that the summary card copy lost.
 *   - I1: `formatSatangThb` + `formatDate` + `statusBadgeVariant`
 *         lived in three places (list page, detail page, summary
 *         card) — Reusable Components principle (CLAUDE.md global
 *         instructions + Constitution § Code Quality).
 *
 * Single source of truth: editing this file updates every portal
 * invoice surface at once. THB currency formatting uses
 * `Intl.NumberFormat` so SV / TH / EN locales format thousands
 * separators correctly (UX Sugg #7).
 */

const THB_FORMATTERS = new Map<string, Intl.NumberFormat>();

/**
 * Format a satang amount as THB. Handles negative values (credit
 * note totals) with an explicit sign prefix — the previous
 * implementation produced `0.-34 THB` because `-3434n % 100n` is
 * `-34n` in BigInt arithmetic, which `.padStart` printed verbatim.
 *
 * Returns `'—'` for null inputs so missing monetary fields read
 * cleanly in the table cells.
 */
export function formatSatangThb(
  satang: bigint | null,
  locale: string = 'en-US',
): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  let fmt = THB_FORMATTERS.get(locale);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { useGrouping: true });
    THB_FORMATTERS.set(locale, fmt);
  }
  return `${sign}${fmt.format(whole)}.${rem.toString().padStart(2, '0')} THB`;
}

/** Medium-style date formatter tolerant of null inputs. */
export function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export type InvoiceStatusBadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'destructive';

/**
 * Map an invoice status enum to a shadcn Badge variant. Colour alone
 * is not a sufficient a11y signal (review Sugg #2 — deuteranopia);
 * callers MUST pair the badge with a `lucide-react` status icon —
 * see `statusIconName` below.
 */
export function statusBadgeVariant(status: string): InvoiceStatusBadgeVariant {
  switch (status) {
    case 'paid':
      return 'default';
    case 'issued':
      return 'secondary';
    case 'overdue':
      return 'destructive';
    default:
      return 'outline';
  }
}

/**
 * lucide-react icon name per invoice status. Callers import the icon
 * component directly (tree-shaking friendly) and render at ~14px
 * inside the Badge with `aria-hidden` since the text label is
 * already present.
 */
export type InvoiceStatusIconName =
  | 'CheckCircle2'
  | 'Clock'
  | 'AlertTriangle'
  | 'FileText'
  | 'Ban';

export function statusIconName(status: string): InvoiceStatusIconName {
  switch (status) {
    case 'paid':
      return 'CheckCircle2';
    case 'issued':
      return 'Clock';
    case 'overdue':
      return 'AlertTriangle';
    case 'void':
      return 'Ban';
    default:
      return 'FileText';
  }
}
