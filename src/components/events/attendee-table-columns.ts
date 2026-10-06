/**
 * Spec 122 US9a (T903/T904) — the attendee table's column layout, shared by
 * the table and the detail route's skeleton (`[eventId]/loading.tsx`) so the
 * loading grid lands where the real one does (CLS 0). Board
 * `Admin-event-detail` (+ `-mobile`): on a phone each attendee is a card
 * titled with the name over the email, the match badge beside it, then the
 * ticket, quota and registration date, with Relink and Erase at its foot.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<
  DataTableColumn,
  'width' | 'minWidth' | 'card' | 'cardOrder' | 'align' | 'hideBelow' | 'actions' | 'skeletonLines' | 'skeletonTouch'
>;

export const ATTENDEE_COLUMN_LAYOUT = {
  // The name over the email (and the company when matched); the card's title.
  attendee: { minWidth: 240, card: 'title', skeletonLines: 2 },
  // The match badge beside the card's title.
  match: { width: 170, card: 'pill' },
  ticket: { width: 150, card: 'field', cardOrder: 2 },
  quota: { width: 150, card: 'field', cardOrder: 3 },
  registered: { width: 130, card: 'field', cardOrder: 4 },
  // Relink and Erase, the card's last row on a phone.
  actions: { width: 220, align: 'end', card: 'footer', skeletonTouch: true },
} as const satisfies Record<string, ColumnLayout>;

export type AttendeeColumnKey = keyof typeof ATTENDEE_COLUMN_LAYOUT;
