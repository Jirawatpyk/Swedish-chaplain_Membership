/**
 * Spec 122 US8 (T809) — the invoices grid's column layout (keys, sizes and
 * phone-card parts), shared by the table and its loading skeleton so the
 * grid that replaces the skeleton lands in the same place (CLS 0,
 * ux-standards § 2.1). The Queue and Method columns are opt-in views a
 * route-level skeleton cannot know about, so they are not listed here.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

/**
 * Sized so the table fits the staff frame's card without scrolling: all
 * seven columns at 1440px (a 1069px box; widths plus AURA's 48px of gutters
 * come to 1044px, and the buyer column takes the rest), and at 1280px (911px)
 * once the Receipt No. column steps aside below a 1000px table. The receipt's
 * state then reads under the number (`RECEIPT_COLUMN_MIN_TABLE_PX`). Narrower
 * tables (a tablet) scroll sideways inside the box.
 */
export const RECEIPT_COLUMN_MIN_TABLE_PX = 1000;

type ColumnLayout = Pick<
  DataTableColumn,
  'width' | 'minWidth' | 'card' | 'align' | 'actions' | 'hideBelow' | 'skeletonLines' | 'skeletonTouch'
>;

export const INVOICES_COLUMN_LAYOUT = {
  // The number over "Issued {date}" (and the credit-note count): two skeleton lines.
  documentNumber: { width: 160, card: 'title', skeletonLines: 2 },
  // A line of its own on a phone card, after Due and Total, so a long legal
  // name wraps instead of being cut at the half-width column.
  memberName: { minWidth: 160, card: 'wide', skeletonLines: 2 },
  status: { width: 136, card: 'pill' },
  dueDate: { width: 100 },
  // The receipt number over its state (generating, method, failed).
  receipt: { width: 136, card: 'hide', hideBelow: RECEIPT_COLUMN_MIN_TABLE_PX, skeletonLines: 2 },
  total: { width: 120, align: 'end' },
  // The phone card's last row, full width (the US7a rule).
  // The ⋯ is 44px on a phone (`touchHeight`), and so is the skeleton's bar.
  actions: { width: 184, actions: true, card: 'footer', skeletonTouch: true },
} as const satisfies Record<string, ColumnLayout>;

export type InvoicesColumnKey = keyof typeof INVOICES_COLUMN_LAYOUT;
