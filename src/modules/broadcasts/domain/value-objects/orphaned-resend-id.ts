/**
 * Spec 140 s2c (DL5b, DL6, DL10) — the orphaned Resend id: a Resend broadcast
 * or audience our side created, whose id no live `broadcasts` row will carry
 * to a cleanup path, recorded so that a cron and the erasure cascade can
 * settle it at Resend (`broadcast_orphaned_resend_ids`, migration 0323).
 *
 * The SQL CHECKs in 0323 list these values by hand; the integration suite
 * `orphaned-resend-ids.test.ts` pins them against these tuples, so the two
 * cannot drift silently.
 *
 * Pure TypeScript — no framework imports (Constitution Principle III).
 */

/** What the id names at Resend. `create_unconfirmed` is always `broadcast`. */
export const ORPHAN_RESOURCE_TYPES = ['broadcast', 'audience'] as const;
export type OrphanResourceType = (typeof ORPHAN_RESOURCE_TYPES)[number];

/**
 * Why the id was orphaned — one value per writer (plan.md § Slice 2c, item 3).
 * `create_unconfirmed` is the one without an id: a `createBroadcast` that ended
 * in a network failure, a timeout or a 5xx may have minted a draft we never
 * learnt the id of. It is never drained (there is nothing to call), only
 * counted by a gauge.
 */
export const ORPHAN_REASONS = [
  'attach_lost',
  'row_vanished',
  'persist_failed',
  'read_back_failed_kept',
  'dead_broadcast_replaced',
  'dead_broadcast_kept',
  'terminal_reclaim_undecided',
  'refused_draft_undeleted',
  'audience_leaked',
  'create_unconfirmed',
] as const;
export type OrphanReason = (typeof ORPHAN_REASONS)[number];

/**
 * What settling the id at Resend decided:
 * - `deleted` / `absent` — gone (a 404 means Resend holds no such resource);
 * - `retained` — an unsent copy Resend will not delete (403, then the GET read
 *   `canceled` or `failed`);
 * - `handed` — Resend had accepted it for sending (403, then queued / sending /
 *   sent): a disclosure, RoPA residual 8c.
 * Anything else leaves the row unsettled for the next run.
 */
export const ORPHAN_OUTCOMES = ['deleted', 'absent', 'retained', 'handed'] as const;
export type OrphanOutcome = (typeof ORPHAN_OUTCOMES)[number];

/**
 * [P M-1] How long a settled row, or a `create_unconfirmed` row, is kept
 * before the retention sweep prunes it (`prune_orphaned_resend_ids`, 0323,
 * which refuses a cutoff younger than this). An UNSETTLED row with an id is
 * never pruned: it still names a copy at Resend.
 */
export const ORPHAN_ROW_RETENTION_DAYS = 90;

/** [A7] The window of the `create_unconfirmed` gauge: rows created in the last 24 h. */
export const ORPHAN_UNCONFIRMED_GAUGE_WINDOW_HOURS = 24;
