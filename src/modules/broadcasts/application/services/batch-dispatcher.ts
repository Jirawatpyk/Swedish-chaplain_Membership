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
 * Semaphore impl: minimal Promise pool (no external dependency). All
 * pending batches are queued; up to `concurrencyCap` are in-flight
 * at any moment; each batch dispatch is independent (one batch's
 * failure does NOT abort the others).
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
  readonly totalBatches: number;
  readonly succeeded: number;
  readonly failed: number;
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
  const queue = [...input.pendingBatches];
  const results: BatchDispatchOutcome[] = [];

  /** Worker — pulls from the queue until empty, dispatches each batch. */
  async function worker(): Promise<void> {
    for (;;) {
      const batch = queue.shift();
      if (batch === undefined) return;

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
    }
  }

  // Spin up `cap` parallel workers, await all to drain the queue.
  const workerCount = Math.min(cap, input.pendingBatches.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

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
    results: sorted,
    elapsedMs: Date.now() - startedAt,
  };
}
