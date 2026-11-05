/**
 * Spec 140 s2c (DL5b, DL6, DL10) — the orphaned Resend id: a Resend broadcast
 * or audience our side created, whose id no live `broadcasts` row will carry
 * to a cleanup path, recorded so that a cron and the erasure cascade can
 * settle it at Resend (`broadcast_orphaned_resend_ids`, migration 0325).
 *
 * The SQL CHECKs in 0325 list these values by hand; the integration suite
 * `orphaned-resend-ids.test.ts` pins them against these tuples, so the two
 * cannot drift silently.
 *
 * Pure TypeScript — no framework imports (Constitution Principle III).
 */
import type { BroadcastStatus } from './broadcast-status';

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
 *   sent): a disclosure, RoPA residual 8c;
 * - `superseded` (review round 2, code-review #2) — the id is held by a row
 *   whose send went out normally (`sent` / `partial_delivery_accepted`): an
 *   ordinary delivery, not erasure evidence.
 *   Settled with no Resend call, never counted in the erasure fields, prunable.
 * Anything else leaves the row unsettled for the next run.
 */
export const ORPHAN_OUTCOMES = ['deleted', 'absent', 'retained', 'handed', 'superseded'] as const;
export type OrphanOutcome = (typeof ORPHAN_OUTCOMES)[number];

/**
 * Review round 2 (code-review #2) — the statuses of a row whose send went out
 * normally. A BROADCAST orphan whose id such a row holds settles `superseded`.
 * Review round 3 (reliability nit) — terminal ones only: `partially_sent` is
 * not terminal, so a row in it already hides the orphan from every list.
 */
export const ORPHAN_SUPERSEDING_STATUSES = ['sent', 'partial_delivery_accepted'] as const satisfies ReadonlyArray<BroadcastStatus>;

/**
 * [P M-1] How long a settled row, or a `create_unconfirmed` row, is kept
 * before the retention sweep prunes it (`prune_orphaned_resend_ids`, 0325,
 * which refuses a cutoff younger than this). An UNSETTLED row with an id is
 * never pruned: it still names a copy at Resend.
 */
export const ORPHAN_ROW_RETENTION_DAYS = 90;

/**
 * Review round 2 (pdpa L-3) — a `handed` row (the durable record of a
 * disclosure) is pruned after this many years: the horizon of the 8c evidence
 * (`audit_log.retention_years` = 5 for the broadcasts evidence rows).
 */
export const ORPHAN_HANDED_RETENTION_YEARS = 5;

/**
 * How much older than `ORPHAN_ROW_RETENTION_DAYS` the retention sweep's cutoff
 * is. The prune function compares the cutoff with the DATABASE clock
 * (`now() - 90 days`) and refuses a younger one, so an app clock running ahead
 * of Neon's would otherwise turn every daily prune into a refusal. One hour
 * covers any plausible skew and only delays a prune by that long.
 */
export const ORPHAN_PRUNE_SKEW_MARGIN_MS = 60 * 60 * 1000;

/**
 * Review round 1 (code-review #1, reliability M-2, pdpa M-B), with review
 * round 2 (security F1/L3, code-review #1, reliability MED) — a TENANT
 * AUDIENCE orphan is STUCK once it has had this many undecided settles
 * (`attempts`) AND is older than `ORPHAN_STUCK_MIN_AGE_MS`. A stuck row no
 * longer withholds another member's `member_erased` (erasure pass (b), at
 * every exit: undecided, past the deadline, over the limit): it is reported
 * (`broadcasts.cascade.orphan_stuck`), counted on `member_erased`
 * (`audience_orphans_stuck_count`) and, once that is written, by
 * `broadcasts_cascade_orphan_stuck_total` (review round 3), still counted by the unsettled
 * gauge, and owned by the runbook. A member's OWN broadcast orphans always
 * withhold.
 *
 * The count alone is not a time: the drain AND every erasure run add
 * attempts, so eight can pile up in minutes. The age floor is the time.
 */
export const ORPHAN_STUCK_ATTEMPTS = 8;

/**
 * Review round 2 — the age floor of the stuck rule (2 h), measured by the
 * injected clock against the row's `created_at`: at least eight
 * `cleanup-audiences` runs (every 15 minutes, `vercel.json`) have had it.
 */
export const ORPHAN_STUCK_MIN_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Spec 140 s2d (#736b) — the latest `created_at` a stuck row can have when
 * judged at `asOf`. The one cutoff of the stuck rule: pass (b), the erasure
 * audience sort and the detach cap all derive it from an instant the caller
 * passes in, so no SQL `now()` takes part.
 */
export function orphanStuckCutoff(asOf: Date): Date {
  return new Date(asOf.getTime() - ORPHAN_STUCK_MIN_AGE_MS);
}

/**
 * Spec 140 s2d (#736b) — the stuck rule (`ORPHAN_STUCK_ATTEMPTS` docblock),
 * judged at `atMs`: tries AND age. Structural, so the Domain imports no port
 * type. `createdAt` is a `Date` (millisecond precision), which is why the SQL
 * form (`orphanStuckSql`) truncates `created_at` to milliseconds.
 */
export function isOrphanStuck(o: { readonly attempts: number; readonly createdAt: Date }, atMs: number): boolean {
  return o.attempts >= ORPHAN_STUCK_ATTEMPTS && o.createdAt.getTime() <= orphanStuckCutoff(new Date(atMs)).getTime();
}

/**
 * The audience loop's grace (1 h): a terminal row's audience is deleted only
 * once its `updated_at` is this old, so a just-terminal broadcast does not race
 * Resend's own post-send processing. The cleanup route passes it as `graceMs`;
 * review round 1 (code-review #3) applies it to an audience ORPHAN whose
 * terminal holder changed recently too, in the drain and in the erasure's
 * audience pass. Review round 2 (code-review #8) moved it here, next to the
 * other orphan constants.
 */
export const AUDIENCE_CLEANUP_GRACE_MS = 60 * 60 * 1000;

/**
 * Review round 3 (code-review #3) — the 8a detach derivation's leaked-audience
 * arm reads at most this many unsettled audience orphans of the tenant, the
 * most-attempted first, so an erasure's detach pairs stay bounded. Review
 * round 4 (code-review #2) — stuck ones (the `ORPHAN_STUCK_ATTEMPTS` rule)
 * rank ahead of the attempts order. An orphan
 * past the cap is not detached: the erasure's audience pass and the drain
 * delete the whole audience (RoPA 8d, the detach-cap residual).
 */
export const ERASURE_DETACH_ORPHAN_AUDIENCE_LIMIT = 10;

/** [A7] The window of the `create_unconfirmed` gauge: rows created in the last 24 h. */
export const ORPHAN_UNCONFIRMED_GAUGE_WINDOW_HOURS = 24;

/**
 * Review round 1 (security M, reliability M-3) — the unsettled-orphan gauge
 * counts rows with an id still unsettled this many hours after they were
 * written: well past the drain's 1 h grace and ~96 of its 15-minute runs.
 */
export const ORPHAN_UNSETTLED_GAUGE_AGE_HOURS = 24;
