/**
 * Spec 122 US8c (T846) — the register grid's column layout (keys, sizes and
 * phone-card parts), shared by the table and its loading skeleton (CLS 0).
 * Board `Admin-invoice-registers` (+ `-mobile`): on a phone each receipt is a
 * card with the number as its title, the buyer on its own line, then the
 * fields.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<DataTableColumn, 'width' | 'minWidth' | 'card' | 'align' | 'skeletonLines'>;

export const TAX_REGISTER_COLUMN_LAYOUT = {
  receiptNo: { width: 200, card: 'title' },
  paymentDate: { width: 112 },
  buyer: { minWidth: 200, card: 'wide' },
  taxId: { width: 136 },
  subtotal: { width: 136, align: 'end' },
  vat: { width: 120, align: 'end' },
  total: { width: 136, align: 'end' },
  vatTreatment: { width: 112 },
  certNo: { width: 104 },
} as const satisfies Record<string, ColumnLayout>;

export type TaxRegisterColumnKey = keyof typeof TAX_REGISTER_COLUMN_LAYOUT;
