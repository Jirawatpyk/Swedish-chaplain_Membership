/**
 * Spec 122 — the tier upgrade queue's column layout (keys, sizes and
 * phone-card parts), shared by the table and the route's loading skeleton so
 * the grid that replaces the skeleton lands in the same place (CLS 0,
 * ux-standards § 2.1).
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<
  DataTableColumn,
  'width' | 'minWidth' | 'card' | 'align' | 'actions' | 'hideBelow' | 'skeletonLines' | 'skeletonTouch'
>;

export const TIER_UPGRADE_COLUMN_LAYOUT = {
  member: { minWidth: 160, card: 'title' },
  // The plan name over "{fee} excl. VAT": the skeleton draws both lines.
  fromPlan: { width: 180, skeletonLines: 2 },
  toPlan: { width: 180, skeletonLines: 2 },
  // The phone card gives the reason and its evidence a line of their own at
  // full width (board Admin-tier-upgrades-mobile; AURA 5.23, #120).
  reason: { minWidth: 240, card: 'wide', skeletonLines: 2 },
  status: { width: 128, card: 'pill' },
  // The phone card's last row, full width (board Admin-tier-upgrades-mobile).
  // Accept and ⋯ are 44px on a phone (`touchHeight`), and so is the skeleton's bar.
  actions: { width: 152, actions: true, align: 'end', card: 'footer', skeletonTouch: true },
} as const satisfies Record<string, ColumnLayout>;

export type TierUpgradeColumnKey = keyof typeof TIER_UPGRADE_COLUMN_LAYOUT;
