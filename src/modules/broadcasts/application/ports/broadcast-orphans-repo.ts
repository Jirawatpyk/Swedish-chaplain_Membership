/**
 * Spec 140 s2c (DL5b, DL6, DL10) — the port over `broadcast_orphaned_resend_ids`
 * (migration 0325): a Resend broadcast or audience our side created whose id
 * no live `broadcasts` row will carry to a cleanup path.
 *
 * Its own port, as the module keeps one per table (`broadcast-versions-repo`,
 * `broadcast-decisions-repo`): the orphan record changes for different reasons
 * than the `broadcasts` row. Bound to one tenant at composition
 * (`makeDrizzleBroadcastOrphansRepo(tenantId)`); every method runs in its own
 * `runInTenant` transaction, checks the bound tenant (`assertTenantBoundTx`)
 * and fences every statement on `tenant_id` (D-029) — RLS + FORCE is the
 * second wall.
 *
 * Writers record at the CALLER that holds the id and the requester, never
 * inside a shared gateway helper (plan.md § Slice 2c, A2). Settlers are the
 * `cleanup-audiences` drain and the erasure cascade. Nothing deletes a row but
 * the retention prune.
 *
 * Pure Application — no framework imports.
 */
import type { BroadcastId } from '../../domain/broadcast';
import type {
  OrphanOutcome,
  OrphanReason,
  OrphanResourceType,
} from '../../domain/value-objects/orphaned-resend-id';

/** One recorded orphan, as the settlers read it. Ids and closed tokens only. */
export interface OrphanedResendIdRef {
  readonly orphanId: string;
  readonly broadcastId: string;
  readonly requestedByMemberId: string;
  readonly resourceType: OrphanResourceType;
  /** Never empty: the settlers read only rows with a known id. */
  readonly resourceId: string;
  readonly reason: OrphanReason;
  readonly createdAt: Date;
  /** `null` = unsettled. */
  readonly outcome: OrphanOutcome | null;
  /** Review round 1 — undecided settles so far (`markOrphanAttempted`). */
  readonly attempts: number;
  /**
   * Review round 2 (code-review #2) — a BROADCAST orphan whose id a row of
   * this tenant in `ORPHAN_SUPERSEDING_STATUSES` holds: that copy was
   * delivered normally, so the settlers record `superseded` with no Resend
   * call. Always `false` for an audience orphan.
   */
  readonly heldBySentRow: boolean;
}

/** What a writer records. `resourceId` is `null` only for `create_unconfirmed` (CHECK `_id_iff_known`). */
export interface RecordOrphanInput {
  readonly broadcastId: BroadcastId | string;
  readonly requestedByMemberId: string;
  readonly resourceType: OrphanResourceType;
  readonly resourceId: string | null;
  readonly reason: OrphanReason;
}

export interface BroadcastOrphansRepo {
  /**
   * Insert one row in its OWN transaction, so it commits whatever the
   * caller's tick does next. `ON CONFLICT DO NOTHING`: the partial unique
   * `broadcast_orphaned_resend_ids_resource_uq` keeps one row per Resend id,
   * the first writer's. Throws on a DB fault — callers go through
   * `recordOrphanBestEffort` (`_record-orphaned-resend-id.ts`), which logs it at
   * critical and never lets it change the tick's answer.
   */
  recordOrphanedResendId(input: RecordOrphanInput): Promise<void>;

  /**
   * The drain's candidates (DL6): unsettled rows with a known id, oldest
   * first, at most `limit`, **and NOT EXISTS a NON-TERMINAL `broadcasts` row in
   * the same tenant holding that id, type-matched** — `broadcast` ↔
   * `resend_broadcast_id`, `audience` ↔ `resend_audience_id` [A1]. A terminal
   * holder does not block: it can never be sent again, and the drain's DELETE
   * is draft-only. Terminal = `TERMINAL_BROADCAST_STATUSES`.
   *
   * The grace period on the ORPHAN is applied by the caller, not here [P H-2]:
   * a row inside the grace is drained at once when its requester is erased,
   * and the members bridge (`getMemberErasedAt`) is the only crossing into
   * members this module has.
   *
   * Review round 1 (code-review #3): for an AUDIENCE orphan, a TERMINAL holder
   * whose `updated_at` is at or after `audienceGraceCutoff` also counts as
   * live — the audience a row just went terminal with is still the existing
   * audience loop's for its `GRACE_MS` (the cleanup route's grace).
   *
   * Review round 1 (code-review #2): `ORDER BY attempts, created_at`, so a row
   * whose settle keeps answering undecided (`markOrphanAttempted`) sinks below
   * every row that has been tried fewer times and cannot hold the head.
   * Review round 2 (code-review #3): rows past the grace come first
   * (`ORDER BY created_at >= audienceGraceCutoff, attempts, created_at`), so
   * rows the caller would hold back cannot fill the `limit`.
   */
  listDrainableOrphans(limit: number, audienceGraceCutoff: Date): Promise<ReadonlyArray<OrphanedResendIdRef>>;

  /**
   * The erasure cascade's view of ONE requester's BROADCAST orphans (DL10):
   * settled AND unsettled rows with a known id, so a re-drive counts the same
   * set [A6a]; the same type-matched NON-TERMINAL rule as the drain.
   */
  listMemberOrphans(requestedByMemberId: string): Promise<ReadonlyArray<OrphanedResendIdRef>>;

  /**
   * [P H-1] The tenant's UNSETTLED AUDIENCE orphans, whoever requested them:
   * a leaked audience holds recipients' contacts. The same holder rule as the
   * drain, the terminal-holder grace (`audienceGraceCutoff`) included; no grace
   * on the orphan itself. At most `limit`, `ORDER BY attempts, created_at`.
   */
  listUnsettledAudienceOrphans(limit: number, audienceGraceCutoff: Date): Promise<ReadonlyArray<OrphanedResendIdRef>>;

  /**
   * Settle one row: a CAS on `settled_at IS NULL`, writing `settled_at = now()`
   * and `outcome` together (CHECK `_settled_pair`). `false` = already settled
   * (a concurrent drain or cascade won); not an error.
   */
  settleOrphan(orphanId: string, outcome: OrphanOutcome): Promise<boolean>;

  /**
   * Review round 1 (code-review #2) — record one undecided settle: a CAS on
   * `settled_at IS NULL` that increments `attempts` and stamps
   * `last_attempted_at = now()`. `false` = the row is settled (or gone); not an
   * error. The drain and both erasure passes call it on every undecided answer.
   */
  markOrphanAttempted(orphanId: string): Promise<boolean>;

  /**
   * [P M-1] The retention prune (`prune_orphaned_resend_ids`, 0325): settled
   * rows and `create_unconfirmed` rows older than `cutoff`. The function
   * refuses a cutoff younger than `ORPHAN_ROW_RETENTION_DAYS`. Returns the
   * number deleted.
   */
  pruneOrphans(cutoff: Date): Promise<number>;
}
