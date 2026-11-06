/**
 * PR-2 Task 3 — `cleanup-orphaned-audiences.ts` Application use-case (defect #5).
 *
 * Deletes the ephemeral per-broadcast Resend audiences created during dispatch
 * for broadcasts that have reached a terminal status (sent / cancelled /
 * failed_to_dispatch / rejected / partial_delivery_accepted). Without this
 * cleanup, Resend audiences accumulate indefinitely, wasting sub-processor
 * storage and obscuring the active-audience count in the Resend dashboard.
 *
 * Design:
 *   - Lists terminal broadcasts whose audience has not yet been deleted
 *     (`audience_deleted_at IS NULL`) and whose `updated_at` is before the
 *     grace cutoff (so a very recently terminal broadcast doesn't race with
 *     Resend's own post-send processing).
 *   - For each candidate: calls `gateway.deleteAudience` (best-effort; 404
 *     resolves — already gone; 5xx / network throws `GatewayThrowable`).
 *     Spec 139 s2 (DA2) — first its `broadcast_audience_deleted` row
 *     (`reason: 'terminal_cleanup'`, the row's requester), deduped per segment
 *     (a restart may have written it already). A storage failure is logged
 *     and counted and the delete goes ahead; an adapter invariant error stops
 *     that candidate's delete (counted `failed`, logged by class).
 *   - On success: stamps `audience_deleted_at` via `markAudienceDeletedInTx`
 *     inside a per-item `broadcastsRepo.withTx(fn)` so the mark is
 *     tenant-scoped (RLS via the `withTx` Drizzle adapter's `runInTenant`
 *     seam — Constitution Principle I). This mirrors the pattern used by
 *     `reconcile-stuck-sending.ts` (the reference cron use-case).
 *   - On throw: logs a structured warning and leaves the row for the next
 *     cron tick. `failed` counter increments; the batch continues.
 *
 * Spec 140 s2c (DL6) — THE ORPHAN DRAIN, a second pass after that loop. It
 * settles at Resend the ids recorded in `broadcast_orphaned_resend_ids` (a
 * leaked mint, a leaked audience, a terminal row's undeleted draft — every
 * writer is listed in the migration 0325 header), with the outcome table of
 * `_settle-orphan-at-resend.ts`, and writes each answer by a settle CAS:
 *   - at most `ORPHAN_DRAIN_LIMIT` rows per run, `ORPHAN_DRAIN_CONCURRENCY` at
 *     a time, past-grace rows first, then by attempts and age (review round
 *     2); a row is never listed while a NON-TERMINAL
 *     `broadcasts` row holds its id (type-matched, [A1]) and `create_unconfirmed`
 *     (no id) never is;
 *   - the grace (`graceMs`, the same as the audience pass) holds a young row
 *     back, EXCEPT when its requester is erased [P H-2]. Spec 140 s2d (#736a)
 *     — anchored on the orphan, not on `erased_at`: the run reads the distinct
 *     requesters of the unsettled in-grace rows (at most
 *     `ORPHAN_ERASED_REQUESTER_CAP`; a full read is logged), asks the members
 *     bridge which are erased (one call, ids in, ids out), and reads those
 *     requesters' unsettled rows of any age FIRST, in-grace rows then
 *     attempts then age, at most `ORPHAN_DRAIN_ERASED_SHARE` (review round 1:
 *     read as share + 1, so a full share shows as `erasedShareFull`); the
 *     past-grace list fills the rest. So an
 *     erased requester's row written at any time after the erasure (a refusal
 *     tick, `failTerminally`, a reconcile re-drive) is settled on the next run,
 *     however many newer in-grace rows other members have, unless the share is
 *     full, Resend's answer stays undecided, or the read failed: a failed
 *     requester list, bridge read or row read is logged once
 *     (`broadcasts.orphan_drain.erased_read_failed`, with the `step` that
 *     failed), sets `erasedReadFailed`, NOT `listFailed`, and the young rows
 *     wait the grace;
 *   - review round 1 (code-review #5): the erased reads and the past-grace
 *     list run side by side (`Promise.all`), each caught on its own;
 *   - no chunk starts once `ORPHAN_DRAIN_STOP_MS` has passed since the run
 *     began; the rest go next run. Review round 3 (code-review #10): a
 *     broadcast row's worst case is a DELETE, `REPROBE_PAUSE_MS`, then a GET
 *     (10 s + 3 s + 10 s, about 23 s, plus the settle tx), so the last chunk
 *     starts before 240 s and ends by about 265 s, inside the route's
 *     `maxDuration` (`CLEANUP_MAX_DURATION_MS`, 300 s);
 *   - undecided rows stay unsettled for the next run.
 * A failed orphan list is logged and does not fail the audience pass; the
 * erased requesters' rows are read beside it and still drain.
 *
 * Tenant-tx approach: `broadcastsRepo.withTx` is the Application-layer seam
 * for opening a tenant-bound Drizzle transaction without importing the
 * Infrastructure `runInTenant` directly (Clean Architecture Principle III).
 * Matches `reconcile-stuck-sending.ts` which uses `deps.broadcastsRepo.withTx`
 * for every per-broadcast DB write.
 *
 * ClockPort: `graceCutoff = new Date(deps.clock.now() - graceMs)`. Injected
 * for deterministic unit testing; production cron passes a `SystemClock`.
 *
 * Logs carry the error CLASS (`err: errKind(e)`) and ids only, never a
 * provider or driver message (it can carry bound parameters).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { errKind } from '@/lib/log-id';
import { pgErrorCode, pgErrorMeta } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';

import type { AuditPort } from '../ports/audit-port';
import type { BroadcastOrphansRepo, OrphanedResendIdRef } from '../ports/broadcast-orphans-repo';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import { recordAudienceDeleted } from './_audience-audit';
import { settleOrphanAtResend } from './_settle-orphan-at-resend';

// Review round 2 (code-review #8) — the grace lives with the other orphan
// constants in the Domain; re-exported here for this module's callers.
export { AUDIENCE_CLEANUP_GRACE_MS } from '../../domain/value-objects/orphaned-resend-id';

// ---------------------------------------------------------------------------
// Bounds (spec 140 s2c, plan.md § Slice 2c, item 5)
// ---------------------------------------------------------------------------

/** The cleanup route's `maxDuration` (300 s), in ms — pinned to the route's literal by the drain test. */
export const CLEANUP_MAX_DURATION_MS = 300_000;

/**
 * No orphan chunk starts later than this into the run. A chunk's slowest row
 * (review round 3, code-review #10) is a broadcast DELETE that answers 404,
 * `REPROBE_PAUSE_MS`, then the confirming GET: 2 × `RESEND_CALL_TIMEOUT_MS` +
 * 3 s ≈ 23 s, plus its settle tx. The last chunk therefore ends by about
 * 265 s, a margin of about 35 s inside `CLEANUP_MAX_DURATION_MS` (the drain
 * test pins STOP + 2 × timeout + pause + 5 s ≤ 300 s).
 */
export const ORPHAN_DRAIN_STOP_MS = 240_000;

/** Orphan rows read per run. */
export const ORPHAN_DRAIN_LIMIT = 20;

/** Orphan rows settled at once (the audience pass's own concurrency). */
export const ORPHAN_DRAIN_CONCURRENCY = 5;

/**
 * Spec 140 s2d (#736a) — at most this many of a run's `ORPHAN_DRAIN_LIMIT`
 * slots go to the erased requesters' rows, so one requester's rows that keep
 * answering undecided cannot take every slot; the past-grace list fills the
 * rest.
 */
export const ORPHAN_DRAIN_ERASED_SHARE = ORPHAN_DRAIN_LIMIT / 2;

/**
 * Spec 140 s2d (#736a) — the in-grace requesters read per run and sent to the
 * members bridge in one call. A full read is logged
 * (`broadcasts.orphan_drain.erased_requesters_capped`); the requesters past it
 * wait the grace.
 */
export const ORPHAN_ERASED_REQUESTER_CAP = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupOrphanedAudiencesDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<
    BroadcastsRepo,
    'listTerminalBroadcastsWithLiveAudience' | 'withTx' | 'markAudienceDeletedInTx' | 'hasAudienceDeletedAuditInTx'
  >;
  /**
   * Spec 139 s2 (DA2) — REQUIRED: the `broadcast_audience_deleted` row is
   * written before each delete. A composition that forgot it would delete
   * segments with no record, silently.
   */
  readonly audit: Pick<AuditPort, 'emit'>;
  readonly broadcastsGateway: Pick<BroadcastsGatewayPort, 'deleteAudience' | 'deleteBroadcastOnce' | 'retrieveBroadcastOnce'>;
  readonly clock: ClockPort;
  /** Spec 140 s2c — the orphaned Resend id record the drain settles. */
  readonly orphans: Pick<
    BroadcastOrphansRepo,
    | 'listDrainableOrphans'
    | 'listInGraceRequesterIds'
    | 'listUnsettledOrphansForRequesters'
    | 'settleOrphan'
    | 'markOrphanAttempted'
  >;
  /**
   * Spec 140 s2c [P H-2] — whether a young row's requester is erased (it then
   * skips the grace). Spec 140 s2d (#736a) — one batched read, ids in, ids out.
   */
  readonly membersBridge: Pick<MembersBridgePort, 'filterErasedMemberIds'>;
  /**
   * Review round 2 (code-review #4) — waits `REPROBE_PAUSE_MS` between a
   * DELETE 404 and its confirming GET. Default: a timer; tests pass a recorder.
   */
  readonly pauseBeforeReprobe?: (ms: number) => Promise<void>;
}

export interface CleanupOrphanedAudiencesInput {
  /**
   * Grace window in milliseconds. Only broadcasts whose `updated_at` is older
   * than `clock.now() - graceMs` are eligible. Prevents racing with Resend's
   * own post-send processing on very recently terminal broadcasts. The
   * orphan drain applies the same window to an orphan's `created_at`.
   */
  readonly graceMs: number;
  /**
   * Maximum candidates to process per invocation. Keeps cron execution time
   * bounded. Production value: 50 (configured at the route layer — matches
   * reconcile-stuck-sending's `MAX_PER_TICK`).
   */
  readonly limit: number;
}

/**
 * Spec 140 s2c — what the orphan drain did this run. Review round 1 (pdpa
 * L-d): `waiting` and `deferred` count OF THE ROWS SEEN THIS RUN (the two
 * reads), not every unsettled row; `erasedShareFull` says the erased read
 * left rows unread.
 */
export interface OrphanDrainOutput {
  /**
   * Rows the two reads returned, one per orphan id: the erased requesters'
   * rows and the past-grace list (spec 140 s2d, #736a).
   */
  readonly listed: number;
  /** Rows settled at Resend and stamped by the CAS. */
  readonly settled: number;
  /** Rows whose Resend answer (or settle write) decided nothing; tried again next run. */
  readonly undecided: number;
  /** Rows inside the grace whose requester is not (known to be) erased. */
  readonly waiting: number;
  /**
   * Rows not reached before `ORPHAN_DRAIN_STOP_MS`, rows over the run's
   * `ORPHAN_DRAIN_LIMIT` once both reads are merged, and (spec 140 s2d,
   * #736a) an erased requester's in-grace rows the share left out.
   */
  readonly deferred: number;
  /** The past-grace orphan list failed (logged at error); the erased requesters' rows still drain. */
  readonly listFailed: boolean;
  /**
   * Spec 140 s2d (#736a, pdpa M-3) — the erased-requester read failed (the
   * requester list, the members bridge or their rows; logged at warn): an
   * erased requester's young rows wait the grace this run.
   */
  readonly erasedReadFailed: boolean;
  /**
   * Review round 1 (the maintainer's /verify finding, reliability L-2) — the
   * erased requesters had more unsettled rows than `ORPHAN_DRAIN_ERASED_SHARE`:
   * the rest wait for the next run, unseen by `deferred`.
   */
  readonly erasedShareFull: boolean;
}

export interface CleanupOrphanedAudiencesOutput {
  /** Total candidates retrieved from the list query. */
  readonly processed: number;
  /** Audiences successfully deleted and marked. */
  readonly deleted: number;
  /** Candidates whose delete threw (left for next cron tick). */
  readonly failed: number;
  /** Spec 140 s2c — the second pass. */
  readonly orphans: OrphanDrainOutput;
}

export type CleanupOrphanedAudiencesError = {
  readonly kind: 'cleanup.server_error';
  /**
   * The error CLASS (`errKind`), never the driver's message. Review round 1
   * (code-review #7) — named for what it holds (was `message`).
   */
  readonly errClass: string;
  /**
   * Review round 1 (code-review #4) — the audience list failed, but the
   * orphan drain still ran: its counts.
   */
  readonly orphans: OrphanDrainOutput;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function cleanupOrphanedAudiences(
  deps: CleanupOrphanedAudiencesDeps,
  input: CleanupOrphanedAudiencesInput,
): Promise<Result<CleanupOrphanedAudiencesOutput, CleanupOrphanedAudiencesError>> {
  const tenantId = deps.tenant.slug;
  const startedAtMs = deps.clock.now().getTime();
  // Nit carried from Task 2 review: derive cutoff from the injected clock,
  // never from `new Date()` directly (deterministic unit testing).
  const graceCutoff = new Date(startedAtMs - input.graceMs);

  let candidates: ReadonlyArray<{ broadcastId: string; resendAudienceId: string; requestedByMemberId: string }>;
  try {
    candidates = await deps.broadcastsRepo.listTerminalBroadcastsWithLiveAudience(
      tenantId,
      graceCutoff,
      input.limit,
    );
  } catch (e) {
    // List failure is unexpected (Neon outage, RLS misconfiguration, etc.)
    // Surface as cleanup.server_error so the cron route can return 500 and
    // the next tick retries. Spec 140 s2c — the class only: a driver message
    // can carry bound parameters. Review round 1 (code-review #4) — the orphan
    // drain does not depend on that list, so it still runs.
    const orphans = await drainOrphans(deps, startedAtMs, graceCutoff);
    return err({ kind: 'cleanup.server_error', errClass: errKind(e), orphans });
  }

  let deleted = 0;
  let failed = 0;

  // Per-candidate body. Each candidate issues `deleteAudience` (bounded at
  // `RESEND_CALL_TIMEOUT_MS`, spec 140 s2a) + a `withTx` write, both
  // independent across candidates. Best-effort per-item: a single failed
  // delete must NOT abort the batch (per project memory
  // `mock-only-tests-miss-throw-paths`: per-item try/catch is MANDATORY and
  // the throw-path test verifies this invariant). `Promise.allSettled` is the
  // outer isolation: one candidate's throw never short-circuits the chunk.
  async function handleOne(candidate: {
    broadcastId: string;
    resendAudienceId: string;
    requestedByMemberId: string;
  }): Promise<void> {
    try {
      // 0. Spec 139 s2 (DA2) — the Art. 30 row, before the delete. An adapter
      //    invariant error throws into the catch below: no delete, `failed`.
      await recordAudienceDeleted(
        deps,
        {
          broadcastId: candidate.broadcastId,
          relatedMemberId: candidate.requestedByMemberId,
          resendAudienceId: candidate.resendAudienceId,
          reason: 'terminal_cleanup',
        },
        'broadcasts.audience_cleanup',
      );

      // 1. Delete the Resend audience. 404/410 → resolves (already gone);
      //    5xx / network → throws GatewayThrowable (caught below).
      await deps.broadcastsGateway.deleteAudience(candidate.resendAudienceId);

      // 2. Stamp audience_deleted_at inside a per-item tenant-bound tx.
      //    `withTx` is the Application-layer port seam for opening a Drizzle
      //    tx with `app.current_tenant` GUC set (mirrors reconcile-stuck-sending).
      await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.markAudienceDeletedInTx(tx, candidate.broadcastId);
      });

      // JS is single-threaded — `deleted++`/`failed++` across concurrently
      // awaited `handleOne` calls are not racy (no interleaving mid-statement).
      deleted++;
    } catch (e) {
      failed++;
      logger.warn(
        { tenantId, broadcastId: candidate.broadcastId, err: errKind(e) },
        'broadcasts.audience_cleanup.delete_failed',
      );
      // Row stays with audience_deleted_at IS NULL → eligible for retry on
      // next cron tick.
    }
  }

  // Process candidates in chunks of CLEANUP_CONCURRENCY via
  // `Promise.allSettled`. Mirrors `reconcile-stuck-sending` (the reference
  // cron use-case), which parallelises at the same concurrency to avoid
  // approaching the Vercel function timeout under a Resend-5xx backlog.
  // Chunked concurrency bounds the per-tick wall-clock to
  // ceil(candidates / CONCURRENCY) × (slowest delete).
  const CLEANUP_CONCURRENCY = 5;
  for (let i = 0; i < candidates.length; i += CLEANUP_CONCURRENCY) {
    const chunk = candidates.slice(i, i + CLEANUP_CONCURRENCY);
    await Promise.allSettled(chunk.map(handleOne));
  }

  const orphans = await drainOrphans(deps, startedAtMs, graceCutoff);

  return ok({ processed: candidates.length, deleted, failed, orphans });
}

/** Spec 140 s2c (DL6) — the second pass (module docblock). Never throws. */
async function drainOrphans(
  deps: CleanupOrphanedAudiencesDeps,
  startedAtMs: number,
  graceCutoff: Date,
): Promise<OrphanDrainOutput> {
  const tenantId = deps.tenant.slug;

  // Spec 140 s2d (#736a) — the erased requesters' rows, anchored on the
  // orphan (plan.md § Slice 2d — plan review): the requesters of the in-grace
  // rows, which of them the members bridge answers as erased (ids in, ids
  // out), then their unsettled rows of any age, at most
  // ORPHAN_DRAIN_ERASED_SHARE (read as share + 1: one more row means the
  // share is full). A failure anywhere on this path does not set listFailed:
  // the past-grace drain still runs and the young rows wait the grace, as a
  // live requester's do. Review round 1 — the line names the read that failed.
  const readErased = async (): Promise<ErasedRead> => {
    let step: ErasedReadStep = 'requesters';
    try {
      // Spec 140 s2d (#736a) — the repo's LIMIT bounds the list. Review round 2
      // (code-review #10) — read cap + 1, so the capped line means truncated:
      // more requesters than the cap exist, and theirs wait the grace.
      const listed = await deps.orphans.listInGraceRequesterIds(graceCutoff, ORPHAN_ERASED_REQUESTER_CAP + 1);
      if (listed.length > ORPHAN_ERASED_REQUESTER_CAP) {
        logger.warn({ tenantId, cap: ORPHAN_ERASED_REQUESTER_CAP }, 'broadcasts.orphan_drain.erased_requesters_capped');
      }
      const requesterIds = listed.slice(0, ORPHAN_ERASED_REQUESTER_CAP);
      if (requesterIds.length === 0) return NO_ERASED_READ;
      step = 'bridge';
      const erased = await deps.membersBridge.filterErasedMemberIds(deps.tenant, requesterIds);
      if (erased.length === 0) return NO_ERASED_READ;
      step = 'rows';
      const read = await deps.orphans.listUnsettledOrphansForRequesters(erased, ORPHAN_DRAIN_ERASED_SHARE + 1, graceCutoff);
      return {
        rows: read.slice(0, ORPHAN_DRAIN_ERASED_SHARE),
        requesters: new Set(erased),
        shareFull: read.length > ORPHAN_DRAIN_ERASED_SHARE,
        failed: false,
      };
    } catch (e) {
      // Review round 2 (code-review #7) — the constraint / table / column names too, never `detail`.
      logger.warn(
        { tenantId, step, err: errKind(e), code: pgErrorCode(e), pg: pgErrorMeta(e) },
        'broadcasts.orphan_drain.erased_read_failed',
      );
      return { ...NO_ERASED_READ, failed: true };
    }
  };

  const readPastGrace = async (): Promise<{ readonly rows: ReadonlyArray<OrphanedResendIdRef>; readonly failed: boolean }> => {
    try {
      return { rows: await deps.orphans.listDrainableOrphans(ORPHAN_DRAIN_LIMIT, graceCutoff), failed: false };
    } catch (e) {
      logger.error({ tenantId, err: errKind(e) }, 'broadcasts.orphan_drain.list_failed');
      return { rows: [], failed: true };
    }
  };

  // Review round 1 (code-review #5) — side by side, each caught on its own,
  // so neither read's latency adds to the other's inside the 240 s budget.
  const [erasedRead, pastRead] = await Promise.all([readErased(), readPastGrace()]);
  const erasedRows = erasedRead.rows;
  const erasedRequesters = erasedRead.requesters;
  const pastFirst = pastRead.rows;

  // One row per orphanId across both reads: the erased requesters' rows
  // first, then the past-grace list.
  const byId = new Map<string, OrphanedResendIdRef>();
  for (const row of [...erasedRows, ...pastFirst]) if (!byId.has(row.orphanId)) byId.set(row.orphanId, row);
  const listed = [...byId.values()];

  // The erased rows are due whatever their age; from the past-grace list, a
  // row past the grace is due. A row inside the grace waits — unless its
  // requester is erased and the share left it out, when it is deferred.
  const inGrace = (row: OrphanedResendIdRef) => row.createdAt.getTime() >= graceCutoff.getTime();
  const erasedIds = new Set(erasedRows.map((row) => row.orphanId));
  const ordered: OrphanedResendIdRef[] = [];
  let waiting = 0;
  let deferred = 0;
  for (const row of listed) {
    if (erasedIds.has(row.orphanId) || !inGrace(row)) ordered.push(row);
    else if (erasedRequesters.has(row.requestedByMemberId)) deferred += 1;
    else waiting += 1;
  }
  const due = ordered.slice(0, ORPHAN_DRAIN_LIMIT);
  deferred += ordered.length - due.length;

  let settled = 0;
  let undecided = 0;
  const settleOne = async (row: OrphanedResendIdRef): Promise<void> => {
    const ids = { tenantId, orphanId: row.orphanId, resourceType: row.resourceType, resourceId: row.resourceId, orphanReason: row.reason };
    const answer = await settleOrphanAtResend(deps.broadcastsGateway, row, deps.pauseBeforeReprobe);
    if (answer.kind === 'undecided') {
      undecided += 1;
      logger.warn({ ...ids, attempts: row.attempts + 1, answer: answer.answer }, 'broadcasts.orphan_drain.undecided');
      // Review round 1 (code-review #2) — the row sinks below untried rows.
      await deps.orphans.markOrphanAttempted(row.orphanId).catch((e: unknown) => {
        logger.warn({ ...ids, err: errKind(e) }, 'broadcasts.orphan_drain.attempt_mark_failed');
      });
      return;
    }
    try {
      // Review round 1 (code-review #6) — counted only when this CAS won.
      if (await deps.orphans.settleOrphan(row.orphanId, answer.outcome)) {
        settled += 1;
        logger.info({ ...ids, outcome: answer.outcome }, 'broadcasts.orphan_drain.settled');
      }
    } catch (e) {
      undecided += 1;
      logger.warn({ ...ids, err: errKind(e) }, 'broadcasts.orphan_drain.settle_failed');
    }
  };

  for (let i = 0; i < due.length; i += ORPHAN_DRAIN_CONCURRENCY) {
    if (deps.clock.now().getTime() - startedAtMs >= ORPHAN_DRAIN_STOP_MS) {
      // Review round 4 (code-review #6) — the line names the rows the budget
      // cut only; the output's deferred stays the total (the cap overflow too).
      const stoppedDeferred = due.length - i;
      deferred += stoppedDeferred;
      logger.warn({ tenantId, stoppedDeferred }, 'broadcasts.orphan_drain.stopped_at_budget');
      break;
    }
    await Promise.allSettled(due.slice(i, i + ORPHAN_DRAIN_CONCURRENCY).map(settleOne));
  }

  return {
    listed: listed.length,
    settled,
    undecided,
    waiting,
    deferred,
    listFailed: pastRead.failed,
    erasedReadFailed: erasedRead.failed,
    erasedShareFull: erasedRead.shareFull,
  };
}

/** Review round 1 (reliability M-1) — the read of the erased path a failure is logged with. */
type ErasedReadStep = 'requesters' | 'bridge' | 'rows';

interface ErasedRead {
  readonly rows: ReadonlyArray<OrphanedResendIdRef>;
  readonly requesters: ReadonlySet<string>;
  readonly shareFull: boolean;
  readonly failed: boolean;
}

const NO_ERASED_READ: ErasedRead = { rows: [], requesters: new Set(), shareFull: false, failed: false };
