/**
 * Spec 122 — the escalation task queue's column layout (keys, sizes and
 * phone-card parts), shared by the table and the route's loading skeleton so
 * the grid that replaces the skeleton lands in the same place (CLS 0,
 * ux-standards § 2.1).
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<
  DataTableColumn,
  'width' | 'minWidth' | 'card' | 'align' | 'actions' | 'hideBelow' | 'skeletonLines' | 'skeletonTouch'
>;

export const ESCALATION_TASK_COLUMN_LAYOUT = {
  member: { minWidth: 160, card: 'title' },
  // The phone card reads the tier with the task type on one line (board
  // Admin-renewal-tasks-mobile).
  tier: { width: 110, card: 'hide' },
  expiresAt: { width: 110, card: 'hide' },
  // The phone card's tier + type line, at full width (board
  // Admin-renewal-tasks-mobile; AURA 5.23, #120).
  taskType: { minWidth: 150, card: 'wide' },
  // The phone card's due + assignee line, at full width.
  dueAt: { width: 165, card: 'wide' },
  // The name over the role: the skeleton draws both lines.
  assignedTo: { width: 150, card: 'hide', skeletonLines: 2 },
  status: { width: 84, card: 'hide' },
  // The phone card's last row: Done grows across it beside the ⋯.
  // Done and ⋯ are 44px on a phone (`touchHeight`), and so is the skeleton's bar.
  actions: { width: 116, actions: true, align: 'end', card: 'footer', skeletonTouch: true },
} as const satisfies Record<string, ColumnLayout>;

export type EscalationTaskColumnKey = keyof typeof ESCALATION_TASK_COLUMN_LAYOUT;
