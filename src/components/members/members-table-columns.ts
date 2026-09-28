/**
 * 122 US5a — the members grid's column sizes, shared by `MembersTable` and
 * `MembersTableSkeleton` so the loading grid has the real table's shape
 * (CLS 0, ux-standards § 2.1). Plain data: the skeleton imports it without
 * the table.
 *
 * Fitted to a ~1,120px table (1440px window): Company is the flexible column
 * and every cell wraps (AURA 5.11 auto rows); Last activity goes first on a
 * narrower table so the row menu stays in view.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnSize = Pick<DataTableColumn, 'width' | 'minWidth' | 'hideBelow'>;

export const MEMBERS_COLUMN_SIZES = {
  company_name: { minWidth: 130 },
  member_number_display: { width: 92 },
  primary_contact: { width: 164, hideBelow: 'lg' },
  plan_display_name: { width: 150, hideBelow: 'lg' },
  // Its two badges wrap onto a second line (auto rows), so it can stay narrow.
  status: { width: 140 },
  engagement: { width: 116 },
  last_activity_at: { width: 132, hideBelow: 1100 },
  actions: { width: 48 },
} as const satisfies Record<string, ColumnSize>;

/** Grid column order (the table's `columns` keys, left to right). */
export const MEMBERS_COLUMN_ORDER = [
  'company_name',
  'member_number_display',
  'primary_contact',
  'plan_display_name',
  'status',
  'engagement',
  'last_activity_at',
  'actions',
] as const satisfies readonly (keyof typeof MEMBERS_COLUMN_SIZES)[];
