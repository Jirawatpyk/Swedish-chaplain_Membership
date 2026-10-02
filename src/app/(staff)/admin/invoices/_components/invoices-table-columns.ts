/**
 * Spec 122 US8 (T809) — the invoices grid's column layout (keys, sizes and
 * phone-card parts), shared by the table and its loading skeleton so the
 * grid that replaces the skeleton lands in the same place (CLS 0,
 * ux-standards § 2.1). The Queue and Method columns are opt-in views a
 * route-level skeleton cannot know about, so they are not listed here.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<DataTableColumn, 'width' | 'minWidth' | 'card' | 'align' | 'actions'>;

export const INVOICES_COLUMN_LAYOUT = {
  documentNumber: { width: 208, card: 'title' },
  memberName: { minWidth: 200 },
  status: { width: 146, card: 'pill' },
  dueDate: { width: 112 },
  receipt: { width: 160, card: 'hide' },
  total: { width: 136, align: 'end' },
  // The phone card's last row, full width (the US7a rule).
  actions: { width: 184, actions: true, card: 'footer' },
} as const satisfies Record<string, ColumnLayout>;

export type InvoicesColumnKey = keyof typeof INVOICES_COLUMN_LAYOUT;
