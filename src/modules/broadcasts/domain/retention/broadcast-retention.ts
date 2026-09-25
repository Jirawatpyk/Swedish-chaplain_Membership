/**
 * F7 retention sweep (migration 0310) — the retention clock of a closed
 * E-Blast.
 *
 * The RoPA declares 5 years for `broadcasts` (and everything that hangs off
 * it); `retention_years` is a per-row column (CHECK IN (5, 10)) so a row can
 * carry the longer period. This file answers the two questions the sweep asks
 * of a row: WHEN did its clock start, and has it run out.
 *
 * THE ANCHOR is the moment the row reached its terminal status — the status's
 * own timestamp column, falling back to `stageEnteredAt` when that column is
 * NULL (a historical row written before the column was stamped). The anchor is
 * NEVER `updatedAt`: the erasure redaction and the audience clean-up both
 * touch a closed row, and either would restart its clock. A row that is not
 * terminal has no clock at all — it is still somebody's work.
 *
 * `RETENTION_ANCHOR_FIELD` is the single source of truth for the mapping. The
 * Drizzle adapter builds its SQL `CASE` from it (the same rule as
 * `TERMINAL_BROADCAST_STATUSES` → `IN (...)`, Finding G), so the SQL that
 * deletes and the function that documents cannot disagree on a column.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import type { Broadcast } from '../broadcast';
import {
  isTerminalStatus,
  type TERMINAL_BROADCAST_STATUSES,
} from '../value-objects/broadcast-status';

export type TerminalBroadcastStatus = (typeof TERMINAL_BROADCAST_STATUSES)[number];

/** The `Broadcast` timestamp fields a retention clock may start from. */
export type RetentionAnchorField =
  | 'sentAt'
  | 'partialDeliveryAcceptedAt'
  | 'failedToDispatchAt'
  | 'rejectedAt'
  | 'cancelledAt'
  | 'stageEnteredAt';

/**
 * Which column starts the clock, per terminal status. A `Record` over the
 * terminal union, so a new terminal status is a compile error here until it
 * is given an anchor.
 */
export const RETENTION_ANCHOR_FIELD: Readonly<Record<TerminalBroadcastStatus, RetentionAnchorField>> = {
  sent: 'sentAt',
  partial_delivery_accepted: 'partialDeliveryAcceptedAt',
  failed_to_dispatch: 'failedToDispatchAt',
  rejected: 'rejectedAt',
  cancelled: 'cancelledAt',
  // The day-30 close (FR-022a) stamps no column of its own; entering the
  // terminal stage is the moment.
  expired_no_member_response: 'stageEnteredAt',
};

/** The fields of a row the retention clock reads — nothing else. */
export type RetentionClockInput = Pick<
  Broadcast,
  'status' | 'retentionYears' | RetentionAnchorField
>;

/**
 * When the row's retention clock started, or `null` when the row is not
 * terminal (and so has no clock).
 */
export function retentionAnchorOf(row: RetentionClockInput): Date | null {
  if (!isTerminalStatus(row.status)) return null;
  const field = RETENTION_ANCHOR_FIELD[row.status as TerminalBroadcastStatus];
  return row[field] ?? row.stageEnteredAt;
}

/**
 * `date` plus `years` calendar years, in UTC, clamping 29 February to
 * 28 February in a non-leap target year — the same result as Postgres
 * `timestamptz + make_interval(years => n)` in a UTC session, which is what
 * the sweep's SQL evaluates. (Plain `setUTCFullYear` would roll to 1 March.)
 */
export function addCalendarYearsUtc(date: Date, years: number): Date {
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDayOfTargetMonth);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** The instant the row's retention runs out, or `null` for a non-terminal row. */
export function retentionExpiresAt(row: RetentionClockInput): Date | null {
  const anchor = retentionAnchorOf(row);
  if (anchor === null) return null;
  return addCalendarYearsUtc(anchor, row.retentionYears);
}

/** True once `now` has reached the row's expiry. Never true for a non-terminal row. */
export function isPastRetention(row: RetentionClockInput, now: Date): boolean {
  const expiresAt = retentionExpiresAt(row);
  return expiresAt !== null && now.getTime() >= expiresAt.getTime();
}
