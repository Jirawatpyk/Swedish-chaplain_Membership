/**
 * Spec 122 US9a (T903/T904) — the attendee table's column layout, shared by
 * the table and the detail route's skeleton (`[eventId]/loading.tsx`) so the
 * loading grid lands where the real one does (CLS 0). Board
 * `Admin-event-detail` (+ `-mobile`): on a phone each attendee is a card
 * titled with the name over the email, then the match, ticket, quota and
 * registration date, with Relink and the row menu at its foot.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<
  DataTableColumn,
  'width' | 'minWidth' | 'card' | 'cardOrder' | 'align' | 'hideBelow' | 'actions' | 'skeletonLines' | 'skeletonTouch'
>;

export const ATTENDEE_COLUMN_LAYOUT = {
  // The name over the email (and the company when matched); the card's title.
  attendee: { minWidth: 240, card: 'title', skeletonLines: 2 },
  match: { width: 170, card: 'field', cardOrder: 1 },
  ticket: { width: 150, card: 'field', cardOrder: 2 },
  quota: { width: 150, card: 'field', cardOrder: 3 },
  registered: { width: 130, card: 'field', cardOrder: 4 },
  // Relink and the row menu.
  actions: { width: 150, align: 'end', actions: true, skeletonTouch: true },
} as const satisfies Record<string, ColumnLayout>;

export type AttendeeColumnKey = keyof typeof ATTENDEE_COLUMN_LAYOUT;
