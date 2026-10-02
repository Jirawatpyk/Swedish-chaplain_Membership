/**
 * Spec 122 — the renewal pipeline grid's column layout (keys, sizes and
 * phone-card parts), shared by the table and the route's loading skeleton so
 * the grid that replaces the skeleton lands in the same place (CLS 0,
 * ux-standards § 2.1).
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<DataTableColumn, 'width' | 'minWidth' | 'card' | 'align' | 'actions' | 'hideBelow'>;

export const PIPELINE_COLUMN_LAYOUT = {
  tierBucket: { width: 104 },
  companyName: { minWidth: 150, card: 'title' },
  expiresAt: { width: 112 },
  urgency: { width: 136, card: 'pill' },
  // Shown at 1440 (a 1071px table), as the board draws it.
  lastReminderAt: { width: 120, hideBelow: 1040 },
  status: { width: 104 },
  // The first to go: most rows read "—", and an issued bill already shows as
  // the "Bill issued" badge beside the urgency pill.
  linkedInvoiceId: { width: 96, hideBelow: 1180, card: 'hide' },
  // Fits the longest "Send reminder" (SV "Skicka påminnelse", 142px) beside
  // the ⋯ and the cell's end padding; the phone card's last row, full width
  // (board Admin-renewals-mobile).
  actions: { width: 200, actions: true, align: 'end', card: 'footer' },
} as const satisfies Record<string, ColumnLayout>;

export type PipelineColumnKey = keyof typeof PIPELINE_COLUMN_LAYOUT;
