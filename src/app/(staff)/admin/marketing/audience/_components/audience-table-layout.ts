/**
 * The marketing audience table's columns, shared by `AudienceTable` and its
 * loading skeleton so the skeleton grid lands where the real one does (CLS 0,
 * ux-standards § 2.1). Plain data, no client code: the skeleton renders on the
 * server and imports it.
 *
 * Fixed widths are sized for the LONGEST locale (FR-050a): SV "Status ej
 * tillgänglig" badge, SV "REGLAGE" header, EN "Broadcasts halted" badge, TH
 * "ผู้ติดต่อรอง" role badge — badges are atomic (`whitespace-nowrap
 * overflow-hidden`), so the column, not the badge, wraps.
 *
 * Contact and Member have no fixed width: they share the spare width of a
 * wide table, so a long company name stops wrapping once there is room
 * (maintainer, 19 Oct 2026). Their minimums, with the fixed columns, set the
 * table's floor: 944px, inside the 959px card at a 1280px window (15px spare),
 * so the table does not scroll sideways there.
 */
export const AUDIENCE_COLUMN_WIDTHS = {
  state: 184,
  switch: 112,
  kind: 112,
  memberStatus: 152,
  lastChange: 124,
} as const;

export const AUDIENCE_SHARED_MIN = { contact: 136, member: 124 } as const;

export type AudienceColumnKey = keyof typeof AUDIENCE_COLUMN_WIDTHS | keyof typeof AUDIENCE_SHARED_MIN;

export const AUDIENCE_COLUMNS_WITH_SWITCH: readonly AudienceColumnKey[] = [
  'contact', 'state', 'switch', 'member', 'kind', 'memberStatus', 'lastChange',
];
export const AUDIENCE_COLUMNS_READ_ONLY: readonly AudienceColumnKey[] = AUDIENCE_COLUMNS_WITH_SWITCH.filter(
  (k) => k !== 'switch',
);

/** True for the columns that share the spare width (a width-less <col>). */
export const isSharedColumn = (key: AudienceColumnKey): key is keyof typeof AUDIENCE_SHARED_MIN =>
  key === 'contact' || key === 'member';

/** A column's floor: its fixed width, or its minimum when it shares. */
export const audienceColumnFloor = (key: AudienceColumnKey): number =>
  isSharedColumn(key) ? AUDIENCE_SHARED_MIN[key] : AUDIENCE_COLUMN_WIDTHS[key];

const sumFloors = (columns: readonly AudienceColumnKey[]): number =>
  columns.reduce((sum, key) => sum + audienceColumnFloor(key), 0);

/** The table's min-width per shape — the skeleton must land on the same box. */
export const AUDIENCE_MIN_WIDTH = {
  withSwitch: sumFloors(AUDIENCE_COLUMNS_WITH_SWITCH),
  readOnly: sumFloors(AUDIENCE_COLUMNS_READ_ONLY),
} as const;
