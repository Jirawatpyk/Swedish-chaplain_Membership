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

// `formatSatangThb` moved to `src/lib/format-thb.ts` (simplify R3,
// 2026-04-26) so cross-module callers (F5 admin refund surface)
// don't cross route-group boundaries. Re-exported here so existing
// portal callers don't break — staged migration; portal imports
// will update to the canonical lib path in a follow-up.
export { formatSatangThb } from '@/lib/format-thb';
import { dateFormatLocale } from '@/lib/intl-locale';

/**
 * Medium-style date formatter tolerant of null inputs. Routes the locale
 * through `dateFormatLocale` so Thai renders the Buddhist-Era year explicitly
 * (`-u-ca-buddhist`) rather than depending on the host ICU build's default
 * calendar for the bare `th` locale (display-only; storage is UTC Gregorian).
 */
export function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(dateFormatLocale(locale), {
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
