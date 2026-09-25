/**
 * F7 retention sweep (migration 0310) — the retention clock of a closed
 * E-Blast.
 *
 * The RoPA declares 5 years for `broadcasts` (and everything that hangs off
 * it); `retention_years` is a per-row column (CHECK IN (5, 10)) so a row can
 * carry the longer period. The clock is `anchor + retention_years`, evaluated
 * in SQL by the sweep; this file owns the one decision the SQL takes from
 * the Domain: WHICH column is the anchor.
 *
 * THE ANCHOR is the moment the row reached its terminal status — the status's
 * own timestamp column, falling back to `stageEnteredAt` when that column is
 * NULL (a historical row written before the column was stamped). The anchor is
 * never `updatedAt` directly: the erasure redaction and the audience clean-up
 * both touch a closed row, and either would restart its clock. (One indirect
 * route exists — migration 0308 backfilled `stage_entered_at` from
 * `COALESCE(submitted_at, updated_at)`, so a pre-0308 row with neither its own
 * column nor `submitted_at` inherits that `updated_at` through the fallback;
 * the RoPA and the cron runbook carry the check query.) A row that is not
 * terminal has no clock at all — it is still somebody's work.
 *
 * `RETENTION_ANCHOR_FIELD` is the single source of truth for the mapping. The
 * Drizzle adapter builds its SQL `CASE` from it (the same rule as
 * `TERMINAL_BROADCAST_STATUSES` → `IN (...)`, Finding G), so the SQL that
 * deletes cannot name a column the Domain did not choose.
 *
 * (The in-memory `retentionAnchorOf` / `retentionExpiresAt` /
 * `isPastRetention` helpers were removed: nothing in production called them —
 * only the SQL decides — and a TypeScript twin of the SQL clock that nothing
 * checks against Postgres is a parity claim without evidence.)
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import type { TERMINAL_BROADCAST_STATUSES } from '../value-objects/broadcast-status';

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
