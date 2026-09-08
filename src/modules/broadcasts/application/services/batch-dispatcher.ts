/**
 * T046 (F7.1a US1) — `BatchDispatcher` Application service.
 *
 * Concurrency-cap semaphore that orchestrates parallel
 * `dispatchBroadcastBatch` (T045) calls for a single broadcast.
 * Reads the per-tenant `dispatch_concurrency_cap` from
 * `tenant_broadcast_settings` (default 4, range 1-8 per FR-002 +
 * Clarifications round-1 Q1). Caller-supplied cap MUST already be
 * validated by `validateConcurrencyCap` (Domain policy T042).
 *
 * Semaphore impl: minimal Promise pool (no external dependency). Up
 * to `concurrencyCap` batches are in-flight at any moment; each batch
 * dispatch is independent (one batch's failure does NOT abort the
 * others).
 *
 * **One wave per invocation** (Phase 9b, T136): at most `concurrencyCap`
 * batches are dispatched per call and the rest stay `pending` for the
 * next cron tick. The reasoning is in the `wave` comment below — it is
 * about `maxDuration` and contact quota, not about throughput.
 *
 * Returned summary tells the cron handler (T055) which batches
 * succeeded/failed without surfacing per-batch Result envelopes —
 * the caller already has the data via T045's manifest writes + audit
 * events.
 *
 * Pure orchestration — no framework imports (Constitution Principle III).
 */
import type {
  BroadcastContent,
  DispatchBroadcastBatchDeps,
  DispatchBroadcastBatchError,
} from '../use-cases/dispatch-broadcast-batch';
import { dispatchBroadcastBatch } from '../use-cases/dispatch-broadcast-batch';
import type { TenantContext } from '@/modules/tenants';
import {
  DEFAULT_CONCURRENCY_CAP,
  MAX_CONCURRENCY_CAP,
  MIN_CONCURRENCY_CAP,
} from '../../domain/policies/batch-concurrency-policy';
import type { BatchManifest } from '../ports/batch-manifests-port';

export interface DispatchAllPendingBatchesInput {
  readonly tenantId: TenantContext;
  readonly broadcastContent: BroadcastContent;
  readonly allRecipients: ReadonlyArray<{ readonly emailLower: string }>;
  readonly pendingBatches: ReadonlyArray<BatchManifest>;
  /**
   * Effective concurrency cap (already validated and clamped to
   * [1, 8] by `validateConcurrencyCap`). The caller (T055 cron) reads
   * the tenant setting + clamps before invoking this service.
   */
  readonly concurrencyCap: number;
  readonly requestId?: string | null;
}

export interface BatchDispatchOutcome {
  readonly batchManifestId: string;
  readonly batchIndex: number;
  readonly outcome:
    | { readonly status: 'sent_to_resend'; readonly providerAudienceId: string }
    | { readonly status: 'failed'; readonly error: DispatchBroadcastBatchError };
}

export interface DispatchAllPendingBatchesOutput {
  /** Every batch that was pending when this invocation started. */
  readonly totalBatches: number;
  readonly succeeded: number;
  readonly failed: number;
  /**
   * Batches left untouched by this invocation because the wave was full
   * (Phase 9b, T136). They are still `pending` and the next `dispatch-batches`
   * tick — five minutes later — picks them up. Always
   * `totalBatches - succeeded - failed`.
   */
  readonly deferredToNextTick: number;
  readonly results: ReadonlyArray<BatchDispatchOutcome>;
  readonly elapsedMs: number;
}

/**
 * Clamp the caller-supplied cap into [MIN, MAX]. Defence-in-depth on
 * top of the Domain `validateConcurrencyCap` policy — the caller
 * SHOULD reject invalid caps with a typed error before reaching here,
 * but a clamp keeps the service safe under all inputs.
 */
function clampConcurrencyCap(cap: number): number {
  if (!Number.isFinite(cap) || cap < MIN_CONCURRENCY_CAP) {
    return DEFAULT_CONCURRENCY_CAP;
  }
  if (cap > MAX_CONCURRENCY_CAP) return MAX_CONCURRENCY_CAP;
  return Math.floor(cap);
}

export async function dispatchAllPendingBatches(
  deps: DispatchBroadcastBatchDeps,
  input: DispatchAllPendingBatchesInput,
): Promise<DispatchAllPendingBatchesOutput> {
  const startedAt = Date.now();
  const cap = clampConcurrencyCap(input.concurrencyCap);
  /**
   * **One wave per invocation** (Phase 9b, T136). The queue holds at most `cap`
   * batches, so each worker dispatches exactly one and stops; the remainder is
   * neither dispatched nor touched and stays `pending` for the next tick.
   *
   * This service used to queue EVERY pending batch and let each worker pull
   * until the queue was empty. That was harmless while a batch held up to
   * `RESEND_PER_AUDIENCE_CAP = 10,000` contacts, because nothing above 10,000
   * recipients existed and there was never a second wave. Phase 9b sizes
   * batches at `DELIVERABLE_RECIPIENTS_PER_TICK` — about 240 s of serial
   * `POST /contacts` each — so a second wave would begin at ~240 s inside a
   * function whose `maxDuration` is 300 and be killed part-way through pushing
   * a fresh audience. That audience is orphaned holding real addresses, its
   * manifest stays `pending`, and the next tick re-pushes the batch from index
   * 0 into ANOTHER new audience: a full batch of contact quota burned per
   * retry, against an account cap of 1,000 on Resend's Free plan.
   *
   * Deferring costs latency, not delivery — `dispatch-batches` runs every five
   * minutes. Do not "optimise" this back into draining the queue.
   *
   * A failed batch still consumes its slot: a failure is fastest exactly when
   * Resend is rejecting at the contact cap, so backfilling would open a second
   * wave through the back door precisely when the account can least afford it.
   *
   * Roll-up is unaffected. `evaluateBatchCompletion` classifies a `pending`
   * manifest as `in_flight` unless `forceComplete` is set (the 24 h backstop),
   * so a deferred batch keeps the broadcast `sending` rather than rolling it to
   * `sent` early.
   */
  const wave = input.pendingBatches.slice(0, cap);
  const queue = [...wave];
  const results: BatchDispatchOutcome[] = [];

  /** Worker — pulls from the queue until empty, dispatches each batch.
   *
   * Phase 3F.4 (F-4 silent-fail fix): each `dispatchBroadcastBatch`
   * call wrapped in try/catch so an uncaught throw (e.g. audit-emit
   * after rollback) is converted to a `{status:'failed'}` outcome
   * entry instead of rejecting the worker. Combined with
   * Promise.allSettled below, one worker's throw can no longer abort
   * the pool's aggregate (previous Promise.all behavior).
   */
  async function worker(): Promise<void> {
    for (;;) {
      const batch = queue.shift();
      if (batch === undefined) return;

      try {
        const result = await dispatchBroadcastBatch(deps, {
          tenantId: input.tenantId,
          batchManifestId: batch.id,
          allRecipients: input.allRecipients,
          broadcastContent: input.broadcastContent,
          requestId: input.requestId ?? null,
        });

        if (result.ok) {
          results.push({
            batchManifestId: batch.id,
            batchIndex: batch.batchIndex,
            outcome: {
              status: 'sent_to_resend',
              providerAudienceId: result.value.providerAudienceId,
            },
          });
        } else {
          results.push({
            batchManifestId: batch.id,
            batchIndex: batch.batchIndex,
            outcome: { status: 'failed', error: result.error },
          });
        }
      } catch (e) {
        results.push({
          batchManifestId: batch.id,
          batchIndex: batch.batchIndex,
          outcome: {
            status: 'failed',
            error: {
              kind: 'dispatch_broadcast_batch.server_error',
              message: e instanceof Error ? e.message : String(e),
            },
          },
        });
      }
    }
  }

  // Spin up `cap` parallel workers. Use Promise.allSettled so one
  // worker's rejection (defence-in-depth — the try/catch above
  // shouldn't let any worker reject anymore, but allSettled prevents
  // a future bug from regressing the aggregate-survival invariant).
  const workerCount = wave.length;
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.allSettled(workers);

  const succeeded = results.filter(
    (r) => r.outcome.status === 'sent_to_resend',
  ).length;
  const failed = results.length - succeeded;

  // Sort results by batchIndex for deterministic output (workers may
  // finish in arbitrary order).
  const sorted = results.sort((a, b) => a.batchIndex - b.batchIndex);

  return {
    totalBatches: input.pendingBatches.length,
    succeeded,
    failed,
    deferredToNextTick: input.pendingBatches.length - results.length,
    results: sorted,
    elapsedMs: Date.now() - startedAt,
  };
}
