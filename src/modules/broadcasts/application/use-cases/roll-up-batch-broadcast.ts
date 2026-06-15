/**
 * Ship-blocker A — `rollUpBatchBroadcast` Application use-case (F7.1a US1).
 *
 * Closes the missing batch-completion roll-up: the F7.1a batch lifecycle
 * dispatched batches + incremented per-batch counters, but NOTHING ever
 * rolled the parent broadcast out of `sending` — `recordPartialSend` had
 * 0 callers and the batch→sent roll-up was "deferred to Phase 3 Cluster
 * 3D" and never built. A >10k broadcast therefore stayed in `sending`
 * forever (until the 24h single-audience reconcile, which mis-handles
 * batched rows), so FR-008a/b/c were unreachable.
 *
 * This use-case is driven by the reconcile-stuck-sending cron sweep
 * (every ~15 min, idempotent). For a `sending` broadcast that was split
 * into batches it:
 *   1. loads all batch manifests
 *   2. evaluates completion (counters reached recipient_count OR the
 *      batch is in a terminal status sent/failed/cancelled)
 *   3. when ALL batches are done:
 *        - ≥1 failed  → `sending → partially_sent` (FR-008a) — admin then
 *          retries (FR-008b) or accepts partial (FR-008c)
 *        - none failed → `sending → sent` + quota consumed (FR-007)
 *
 * The `sending → sent` / `sending → partially_sent` UPDATE transitions
 * only became possible once H-1 (migration 0217) taught the DB trigger
 * the F7.1a edges; before that they raised. The counters this reads are
 * only trustworthy once F7-SF-1 deduped the batch webhook path.
 *
 * Pure Application — Domain types + ports only.
 */
import { err, ok, type Result } from '@/lib/result';
import { unsafeIanaTimezone, type TenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

import type { BroadcastId } from '../../domain/broadcast';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import type {
  BatchManifest,
  BatchManifestsPort,
} from '../ports/batch-manifests-port';
import {
  BroadcastConcurrentMutationError,
  type BroadcastsRepo,
} from '../ports/broadcasts-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';

import { currentQuotaYear } from './compute-quota-counter';
import { AUTO_RETRY_BUDGET } from './auto-retry-failed-batches';

/** 24h batched-row backstop (mirrors STUCK_SENDING_THRESHOLD_MS). */
const STUCK_BATCH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface BatchCompletion {
  readonly allDone: boolean;
  readonly anyFailed: boolean;
  readonly failedBatchIds: readonly string[];
}

/**
 * Per-batch disposition — EXACTLY ONE per batch.
 *
 * Modelling each batch as a single classified disposition (rather than two
 * independently-computed `cleanlySent` / `notSent` booleans) makes the
 * review-A–E bug class UNREPRESENTABLE: "neither done" (the stuck-forever
 * pending bug, review D) and "both clean and failed" (the failed-masked-as-
 * clean bug, review B/E) cannot occur because a batch resolves to one and
 * only one of these. `classifyBatch` is TOTAL over `BatchStatus` — the
 * `default: never` arm is the compile-time exhaustiveness proof, so adding a
 * new batch status fails to build until it is handled here.
 */
type BatchDisposition =
  /** Not done — keeps the broadcast in `sending` (blocks `allDone`). */
  | { readonly kind: 'in_flight' }
  /** Counts toward a clean broadcast `sent`. */
  | { readonly kind: 'clean_sent' }
  /** Dispatch failed, retry budget spent (or forced at 24h) → partial. */
  | { readonly kind: 'failed_terminal'; readonly batchId: string }
  /** Admin-cancelled mid-dispatch → partial. */
  | { readonly kind: 'cancelled'; readonly batchId: string }
  /** 24h backstop gave up on an un-confirmed/un-dispatched batch → partial. */
  | { readonly kind: 'abandoned'; readonly batchId: string };

/**
 * Classify one batch. `force` is the 24h-backstop give-up flag.
 *
 * "failed" here means the BATCH dispatch failed (status), NOT individual
 * recipient bounces.
 */
function classifyBatch(b: BatchManifest, force: boolean): BatchDisposition {
  // `counterComplete` mirrors the single-audience completion formula
  // (delivered+bounced+complained, see process-webhook-event.ts): it
  // EXCLUDES unsubscribed (a post-delivery event additive to delivered →
  // summing it double-counts one recipient, review A) and requires
  // recipient_count > 0 (a 0-recipient batch must never silently roll the
  // broadcast to sent + burn quota, review C — mirrors the MVP zero-guard).
  const terminalCount = b.deliveredCount + b.bouncedCount + b.complainedCount;
  const counterComplete =
    b.recipientCount > 0 && terminalCount >= b.recipientCount;
  switch (b.status) {
    case 'sent':
      return { kind: 'clean_sent' };
    case 'sending':
      // Cleanly sent only once every recipient reached a terminal delivery
      // event. Under the backstop an UNconfirmed sending batch is abandoned
      // (partial) — never a clean sent that masks zero-delivery (review E).
      if (counterComplete) return { kind: 'clean_sent' };
      if (force) return { kind: 'abandoned', batchId: b.id };
      return { kind: 'in_flight' };
    case 'pending':
      // "Not currently dispatched" — any counters it holds are STALE from a
      // prior attempt (auto-retry re-queues failed→pending without zeroing
      // counters), so under the backstop it abandons regardless of the
      // counter sum (review D + Low-1: a pending batch must never stay stuck
      // forever, and never count as a clean sent).
      if (force) return { kind: 'abandoned', batchId: b.id };
      return { kind: 'in_flight' };
    case 'failed':
      // A cooling-off failure with retry_count < budget is still
      // retry-eligible → stay in_flight until the budget is truly spent;
      // forceComplete gives up at 24h (review B — counters never override
      // failed status into a clean sent).
      if (force || b.retryCount >= AUTO_RETRY_BUDGET)
        return { kind: 'failed_terminal', batchId: b.id };
      return { kind: 'in_flight' };
    case 'cancelled':
      return { kind: 'cancelled', batchId: b.id };
    default: {
      // Exhaustiveness proof — a new BatchStatus must be handled above.
      const _exhaustive: never = b.status;
      return _exhaustive;
    }
  }
}

/**
 * Fold per-batch dispositions into the broadcast-level completion summary:
 * are ALL batches done (no further progress expected), and did any END such
 * that the broadcast can't be a clean `sent`? `anyFailed`/`failedBatchIds`
 * are a derived view of the dispositions (computed once at the single
 * construction site below — they cannot disagree).
 */
export function evaluateBatchCompletion(
  batches: readonly BatchManifest[],
  opts: { readonly forceComplete?: boolean } = {},
): BatchCompletion {
  if (batches.length === 0) {
    return { allDone: false, anyFailed: false, failedBatchIds: [] };
  }
  const force = opts.forceComplete === true;
  const failedBatchIds: string[] = [];
  let allDone = true;
  for (const b of batches) {
    const disposition = classifyBatch(b, force);
    switch (disposition.kind) {
      case 'in_flight':
        allDone = false;
        break;
      case 'clean_sent':
        break;
      case 'failed_terminal':
      case 'cancelled':
      case 'abandoned':
        failedBatchIds.push(disposition.batchId);
        break;
      default: {
        const _exhaustive: never = disposition;
        void _exhaustive;
        break;
      }
    }
  }
  return {
    allDone,
    anyFailed: failedBatchIds.length > 0,
    failedBatchIds,
  };
}

export type RollUpOutcome =
  | { readonly kind: 'broadcast_not_found' }
  | { readonly kind: 'skipped'; readonly observedStatus: BroadcastStatus }
  | { readonly kind: 'skipped_no_batches' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'rolled_up_sent'; readonly quotaYear: number }
  | { readonly kind: 'rolled_up_partial'; readonly failedBatchCount: number };

export type RollUpError = {
  readonly kind: 'roll_up.server_error';
  readonly message: string;
};

export interface RollUpBatchBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly batchManifests: BatchManifestsPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface RollUpBatchBroadcastInput {
  readonly broadcastId: BroadcastId;
  readonly requestId: string | null;
}

export async function rollUpBatchBroadcast(
  deps: RollUpBatchBroadcastDeps,
  input: RollUpBatchBroadcastInput,
): Promise<Result<RollUpOutcome, RollUpError>> {
  const tenantId = deps.tenant.slug;
  const now = deps.clock.now();

  try {
    const broadcast = await deps.broadcastsRepo.findById(
      tenantId,
      input.broadcastId,
    );
    if (broadcast === null) {
      return ok({ kind: 'broadcast_not_found' as const });
    }
    if (broadcast.status !== 'sending') {
      return ok({ kind: 'skipped' as const, observedStatus: broadcast.status });
    }

    const batches = await deps.batchManifests.findByBroadcast(
      tenantId,
      input.broadcastId,
    );
    if (batches.length === 0) {
      // Single-audience broadcast — completion is the F7 MVP webhook /
      // 24h reconcile path, not this batch roll-up.
      return ok({ kind: 'skipped_no_batches' as const });
    }

    // 24h backstop (H-1 review) — if the broadcast has been `sending`
    // longer than 24h, give up waiting for the last webhooks / cooling-off
    // retries and roll up with whatever the batches' statuses say. Batched
    // analogue of reconcile-stuck-sending's STUCK_SENDING_THRESHOLD_MS; the
    // single-audience reconcile loop now EXCLUDES batched rows so it can't
    // mis-mark them failed_to_dispatch.
    const isStuck =
      broadcast.sendingStartedAt != null &&
      now.getTime() - broadcast.sendingStartedAt.getTime() >
        STUCK_BATCH_THRESHOLD_MS;
    const completion = evaluateBatchCompletion(batches, {
      forceComplete: isStuck,
    });
    if (!completion.allDone) {
      return ok({ kind: 'in_progress' as const });
    }

    // Audit-emit altitude (speckit-review I-2): both roll-up transitions
    // below emit the audit row INSIDE `withTx` (atomic with applyTransition),
    // NOT post-commit via `safeAuditEmit`. This is deliberate — the roll-up
    // consumes the member's annual quota (FR-007), so the quota-consumption
    // audit MUST co-commit with the state change (no "sent with no audit"
    // window). The trade-off is that an audit-adapter fault rolls the tx back
    // and returns roll_up.server_error; that's safe because the sweep is
    // idempotent (CAS on expectedFromStatus='sending') and re-attempts the
    // whole roll-up on the next tick. The dispatch path uses post-commit
    // safeAuditEmit instead because there audit loss must NOT block the send.
    if (completion.anyFailed) {
      // FR-008a — ≥1 batch failed after exhausting its retry budget.
      return await deps.broadcastsRepo.withTx(async (tx) => {
        await deps.broadcastsRepo.applyTransition(
          tx,
          tenantId,
          broadcast.broadcastId,
          'partially_sent',
          {},
          'sending',
        );
        // review-fix F (migration 0220) — dedicated `broadcast_partially_sent`
        // event. Previously this reused `broadcast_send_timeout_completed`
        // (the 24h single-audience reconcile event) which made name-keyed
        // alerts / the stuck-sending runbook misfire on a NORMAL (non-24h)
        // partial roll-up. On-call can now key on the event name directly;
        // the payload still carries `outcome` + `viaBatchRollup` for pivots.
        await deps.audit.emit(tx, {
          eventType: 'broadcast_partially_sent',
          tenantId,
          actorUserId: 'system:batch-rollup',
          summary: `Broadcast ${broadcast.broadcastId} rolled up to partially_sent (${completion.failedBatchIds.length} batch(es) failed)`,
          payload: {
            broadcastId: broadcast.broadcastId,
            memberId: broadcast.requestedByMemberId,
            outcome: 'partially_sent',
            failedBatchCount: completion.failedBatchIds.length,
            viaBatchRollup: true,
            rolledUpAt: now.toISOString(),
          },
          requestId: input.requestId,
        });
        return ok({
          kind: 'rolled_up_partial' as const,
          failedBatchCount: completion.failedBatchIds.length,
        });
      });
    }

    // All batches delivered — FR-007 sending → sent + consume quota.
    const tenantTz = unsafeIanaTimezone(env.tenant.timezone);
    const quotaYear = currentQuotaYear(now, tenantTz);
    return await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.applyTransition(
        tx,
        tenantId,
        broadcast.broadcastId,
        'sent',
        {
          sentAt: now,
          quotaYearConsumed: quotaYear,
          quotaConsumedAt: now,
        },
        'sending',
      );
      await deps.audit.emit(tx, {
        eventType: 'broadcast_sent',
        tenantId,
        actorUserId: 'system:batch-rollup',
        summary: `Broadcast ${broadcast.broadcastId} rolled up to sent (all batches complete)`,
        payload: {
          broadcastId: broadcast.broadcastId,
          memberId: broadcast.requestedByMemberId,
          sentAt: now.toISOString(),
          viaBatchRollup: true,
        },
        requestId: input.requestId,
      });
      await deps.audit.emit(tx, {
        eventType: 'broadcast_quota_consumed',
        tenantId,
        actorUserId: 'system:batch-rollup',
        summary: `Quota slot consumed for broadcast ${broadcast.broadcastId} (year ${quotaYear})`,
        payload: {
          broadcastId: broadcast.broadcastId,
          memberId: broadcast.requestedByMemberId,
          quotaYear,
          quotaConsumedAt: now.toISOString(),
          viaBatchRollup: true,
        },
        requestId: input.requestId,
      });
      return ok({ kind: 'rolled_up_sent' as const, quotaYear });
    });
  } catch (e) {
    // A concurrent transition out of 'sending' (another tick / a cancel)
    // makes the guarded applyTransition return 0 rows → benign race, the
    // broadcast is no longer ours to roll up. Mirror reconcile-stuck-sending.
    if (e instanceof BroadcastConcurrentMutationError) {
      return ok({ kind: 'skipped' as const, observedStatus: e.observedStatus });
    }
    return err({
      kind: 'roll_up.server_error' as const,
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}

// ---------------------------------------------------------------------------
// Sweep — the reconcile-cron entry point that finds every `sending`
// broadcast with batches and rolls up the ones whose batches are done.
// ---------------------------------------------------------------------------

export interface SweepBatchCompletionInput {
  readonly limit?: number;
  readonly requestId?: string | null;
}

export interface SweepBatchCompletionOutput {
  readonly scanned: number;
  readonly sentCount: number;
  readonly partialCount: number;
  readonly inProgressCount: number;
  readonly errorCount: number;
}

export async function sweepBatchCompletion(
  deps: RollUpBatchBroadcastDeps,
  input: SweepBatchCompletionInput = {},
): Promise<SweepBatchCompletionOutput> {
  const candidates =
    await deps.batchManifests.findSendingBroadcastIdsWithBatches(
      deps.tenant.slug,
      input.limit ?? 50,
    );

  let sentCount = 0;
  let partialCount = 0;
  let inProgressCount = 0;
  let errorCount = 0;

  for (const broadcastId of candidates) {
    try {
      const result = await rollUpBatchBroadcast(deps, {
        broadcastId,
        requestId: input.requestId ?? null,
      });
      if (!result.ok) {
        errorCount++;
        logger.error(
          {
            tenantId: deps.tenant.slug,
            broadcastId: broadcastId as unknown as string,
            err: result.error.message,
          },
          'broadcasts.batch_rollup.failed',
        );
        continue;
      }
      switch (result.value.kind) {
        case 'rolled_up_sent':
          sentCount++;
          break;
        case 'rolled_up_partial':
          partialCount++;
          break;
        case 'in_progress':
          inProgressCount++;
          break;
        default:
          break;
      }
    } catch (e) {
      // Per-item guard (F7-SF-2 lesson) — one broadcast's throw must not
      // abort the sweep; the next reconcile tick re-picks it.
      errorCount++;
      logger.error(
        {
          tenantId: deps.tenant.slug,
          broadcastId: broadcastId as unknown as string,
          err: e instanceof Error ? e.message : String(e),
        },
        'broadcasts.batch_rollup.threw',
      );
    }
  }

  return {
    scanned: candidates.length,
    sentCount,
    partialCount,
    inProgressCount,
    errorCount,
  };
}
