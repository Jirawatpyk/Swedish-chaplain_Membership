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
import { getDateFormatLocale } from '@/lib/format-date-localised';
import type { InvoiceStatus } from '@/modules/invoicing';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  FileText,
  type LucideIcon,
} from 'lucide-react';

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
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(getDateFormatLocale(locale), {
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
export function statusBadgeVariant(
  status: InvoiceRowDisplayStatus,
): InvoiceStatusBadgeVariant {
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

export function statusIconName(
  status: InvoiceRowDisplayStatus,
): InvoiceStatusIconName {
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

/**
 * Maps each {@link InvoiceStatusIconName} to its `lucide-react` component.
 * Single source of truth — every portal invoice surface (list table,
 * mobile card list, summary card, detail page) resolves its status icon
 * through {@link statusIcon} below instead of redeclaring this map, so the
 * status → icon pairing can never drift between surfaces.
 */
export const STATUS_ICON_MAP: Record<InvoiceStatusIconName, LucideIcon> = {
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  Ban,
};

/**
 * Resolve the `lucide-react` icon component for an invoice row status.
 * Callers render it at ~14px inside the Badge with `aria-hidden` (the text
 * label is already present). Tied to {@link InvoiceRowDisplayStatus} so a
 * stale/typo status is a compile error at the render site.
 */
export function statusIcon(status: InvoiceRowDisplayStatus): LucideIcon {
  return STATUS_ICON_MAP[statusIconName(status)];
}
