/**
 * Spec 122 US8c (T844) — the credit-notes grid's column layout (keys, sizes
 * and phone-card parts), shared by the table and its loading skeleton so the
 * grid that replaces the skeleton lands in the same place (CLS 0,
 * ux-standards § 2.1). Board `Admin-credit-notes`.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<
  DataTableColumn,
  'width' | 'minWidth' | 'card' | 'align' | 'actions' | 'hideBelow' | 'skeletonLines' | 'skeletonTouch'
>;

export const CREDIT_NOTES_COLUMN_LAYOUT = {
  // The number, with the Refund chip beside it.
  documentNumber: { width: 184, card: 'title' },
  issueDate: { width: 112 },
  // The receipt number over the bill (or document kind) it belongs to; a line
  // of its own on a phone card, where "Combined tax invoice + receipt" would
  // be cut at half width.
  originalReceipt: { width: 168, card: 'wide', skeletonLines: 2 },
  // Long legal names and reasons wrap on a line of their own on a phone card.
  member: { minWidth: 160, card: 'wide', skeletonLines: 2 },
  reason: { minWidth: 180, card: 'wide', skeletonLines: 2 },
  total: { width: 128, align: 'end' },
  // The download: on a phone card an icon at the top right beside the number
  // (AURA's place for an `actions` column), 44px. It is the list's only
  // action, so it gets no row of its own (maintainer, 3 Oct).
  pdf: { width: 64, actions: true, skeletonTouch: true },
} as const satisfies Record<string, ColumnLayout>;

export type CreditNotesColumnKey = keyof typeof CREDIT_NOTES_COLUMN_LAYOUT;
