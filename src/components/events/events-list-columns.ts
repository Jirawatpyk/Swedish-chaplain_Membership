/**
 * Spec 122 US9a (T902) — the events table's column layout, shared by the
 * table and the route's skeleton (`events/loading.tsx`) so the loading grid
 * lands where the real one does (CLS 0). Board `Admin-events` (+ `-mobile`):
 * on a phone each event is a card titled with its name, the date and category
 * above it, then the badges, the registrations and the match rate.
 */
import type { DataTableColumn } from '@jirawatpyk/aura-react';

type ColumnLayout = Pick<
  DataTableColumn,
  'width' | 'minWidth' | 'card' | 'cardOrder' | 'align' | 'hideBelow' | 'skeletonLines'
>;

export const EVENTS_LIST_COLUMN_LAYOUT = {
  date: { width: 130, card: 'field', cardOrder: 1 },
  // The name with the "Archived" badge beside it; the card's title.
  name: { minWidth: 220, card: 'title' },
  category: { width: 150, card: 'field', cardOrder: 2 },
  // Numbers align to the start, as the board draws them (parity comment, 6 Oct).
  registrations: { width: 120, card: 'field', cardOrder: 4 },
  // Wide enough for both badges on one line, as on the board.
  partnerBenefit: { width: 250, card: 'wide', cardOrder: 3 },
  // The percentage with its band word over "35 of 42 matched".
  matchRate: { width: 160, card: 'field', cardOrder: 5, skeletonLines: 2 },
} as const satisfies Record<string, ColumnLayout>;

export type EventsListColumnKey = keyof typeof EVENTS_LIST_COLUMN_LAYOUT;
