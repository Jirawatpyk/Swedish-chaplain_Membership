/**
 * Spec 122 US8c (T846) — the register grid's column layout (keys, sizes and
 * phone-card parts), shared by the table and its loading skeleton (CLS 0).
 * Board `Admin-invoice-registers` (+ `-mobile`): all nine columns fit the
 * table card at 1440 and 1280px (edge to edge); on a phone each receipt is a
 * compact card — the number as its title, the buyer with the date, tax ID,
 * treatment and amounts under it, then the total.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<DataTableColumn, 'width' | 'minWidth' | 'card' | 'align' | 'skeletonLines'>;

export const TAX_REGISTER_COLUMN_LAYOUT = {
  // The number, the Cancelled badge wrapping under it.
  receiptNo: { width: 144, card: 'title' },
  paymentDate: { width: 104, card: 'hide' },
  // On a phone card the buyer line also carries the date, tax ID, treatment
  // and amounts (board `Admin-invoice-registers-mobile`).
  buyer: { minWidth: 140, card: 'wide', skeletonLines: 3 },
  taxId: { width: 128, card: 'hide' },
  subtotal: { width: 124, align: 'end', card: 'hide' },
  vat: { width: 112, align: 'end', card: 'hide' },
  // The card's last line, after the buyer (board mobile).
  total: { width: 124, align: 'end', card: 'wide' },
  vatTreatment: { width: 96, card: 'hide' },
  certNo: { width: 84, card: 'hide' },
} as const satisfies Record<string, ColumnLayout>;

export type TaxRegisterColumnKey = keyof typeof TAX_REGISTER_COLUMN_LAYOUT;
