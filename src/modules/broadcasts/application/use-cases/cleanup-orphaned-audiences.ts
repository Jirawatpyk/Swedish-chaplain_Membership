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
 *     back, EXCEPT when its requester is erased [P H-2]: a row written after
 *     `member_erased` is drained on the next tick (a failed erased read waits);
 *   - no chunk starts once `ORPHAN_DRAIN_STOP_MS` has passed since the run
 *     began, which leaves one chunk's two bounded calls inside the route's
 *     `maxDuration` (`CLEANUP_MAX_DURATION_MS`); the rest go next run;
 *   - undecided rows stay unsettled for the next run.
 * A failed orphan list is logged and does not fail the audience pass.
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
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';

import type { BroadcastOrphansRepo, OrphanedResendIdRef } from '../ports/broadcast-orphans-repo';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
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
 * No orphan chunk starts later than this into the run: one chunk's two
 * bounded calls (2 × `RESEND_CALL_TIMEOUT_MS`) plus its settle still finish
 * inside `CLEANUP_MAX_DURATION_MS` (pinned by the drain test).
 */
export const ORPHAN_DRAIN_STOP_MS = 240_000;

/** Orphan rows read per run. */
export const ORPHAN_DRAIN_LIMIT = 20;

/** Orphan rows settled at once (the audience pass's own concurrency). */
export const ORPHAN_DRAIN_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupOrphanedAudiencesDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'listTerminalBroadcastsWithLiveAudience' | 'withTx' | 'markAudienceDeletedInTx'>;
  readonly broadcastsGateway: Pick<BroadcastsGatewayPort, 'deleteAudience' | 'deleteBroadcastOnce' | 'retrieveBroadcastOnce'>;
  readonly clock: ClockPort;
  /** Spec 140 s2c — the orphaned Resend id record the drain settles. */
  readonly orphans: Pick<BroadcastOrphansRepo, 'listDrainableOrphans' | 'settleOrphan' | 'markOrphanAttempted'>;
  /** Spec 140 s2c [P H-2] — whether a young row's requester is erased (it then skips the grace). */
  readonly membersBridge: Pick<MembersBridgePort, 'getMemberErasedAt'>;
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

/** Spec 140 s2c — what the orphan drain did this run. */
export interface OrphanDrainOutput {
  /** Rows the list returned. */
  readonly listed: number;
  /** Rows settled at Resend and stamped by the CAS. */
  readonly settled: number;
  /** Rows whose Resend answer (or settle write) decided nothing; tried again next run. */
  readonly undecided: number;
  /** Rows inside the grace whose requester is not (known to be) erased. */
  readonly waiting: number;
  /** Rows not reached before `ORPHAN_DRAIN_STOP_MS`. */
  readonly deferred: number;
  /** The orphan list itself failed (logged at error). */
  readonly listFailed: boolean;
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
  /** The error CLASS (`errKind`), never the driver's message. */
  readonly message: string;
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

  let candidates: ReadonlyArray<{ broadcastId: string; resendAudienceId: string }>;
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
    return err({ kind: 'cleanup.server_error', message: errKind(e), orphans });
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
  }): Promise<void> {
    try {
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
  let listed: ReadonlyArray<OrphanedResendIdRef>;
  try {
    listed = await deps.orphans.listDrainableOrphans(ORPHAN_DRAIN_LIMIT, graceCutoff);
  } catch (e) {
    logger.error({ tenantId, err: errKind(e) }, 'broadcasts.orphan_drain.list_failed');
    return { listed: 0, settled: 0, undecided: 0, waiting: 0, deferred: 0, listFailed: true };
  }

  // [P H-2] — one erased read per DISTINCT requester of a row inside the
  // grace, all at once (review round 2, code-review #9: at most
  // ORPHAN_DRAIN_LIMIT reads). A failed read counts as not erased: the row waits.
  const inGrace = (row: OrphanedResendIdRef) => row.createdAt.getTime() >= graceCutoff.getTime();
  const requesters = [...new Set(listed.filter(inGrace).map((row) => row.requestedByMemberId))];
  const erasedRequesters = new Set<string>();
  await Promise.all(
    requesters.map(async (memberId) => {
      try {
        const r = await deps.membersBridge.getMemberErasedAt(deps.tenant, memberId);
        if (r !== null && r.erasedAt !== null) erasedRequesters.add(memberId);
      } catch (e) {
        logger.warn({ tenantId, err: errKind(e) }, 'broadcasts.orphan_drain.erased_read_failed');
      }
    }),
  );

  const due: OrphanedResendIdRef[] = [];
  let waiting = 0;
  for (const row of listed) {
    if (!inGrace(row) || erasedRequesters.has(row.requestedByMemberId)) {
      due.push(row);
    } else {
      waiting += 1;
    }
  }

  let settled = 0;
  let undecided = 0;
  let deferred = 0;
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
      deferred = due.length - i;
      logger.warn({ tenantId, deferred }, 'broadcasts.orphan_drain.stopped_at_budget');
      break;
    }
    await Promise.allSettled(due.slice(i, i + ORPHAN_DRAIN_CONCURRENCY).map(settleOne));
  }

  return { listed: listed.length, settled, undecided, waiting, deferred, listFailed: false };
}
