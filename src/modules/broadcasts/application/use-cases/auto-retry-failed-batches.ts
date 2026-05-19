/**
 * T056 (F7.1a US1) — `autoRetryFailedBatches` Application use case.
 *
 * FR-005: every batch_manifest that lands in `failed` state may be
 * auto-retried up to **5 times** (DB CHECK constraint on
 * `retry_count BETWEEN 0 AND 5` from migration 0163). When the budget
 * is exhausted, the row stays `failed` permanently and the
 * `reconcile-stuck-sending` admin escalation path (T047 manual retry
 * OR T048 accept-partial) takes over.
 *
 * This use case is the AUTOMATED counterpart to T047
 * `retryFailedBatches` (admin-triggered). Differences:
 *   - Auto-retry has 5-attempt budget; manual-retry has 3-attempt budget
 *     (different DB columns: `retry_count` vs `manual_retry_count`)
 *   - Auto-retry is per-batch, called by reconcile cron; manual-retry
 *     is per-broadcast, called by admin route
 *   - Auto-retry has cool-off window (15 min default — avoids storming
 *     Resend after a transient outage)
 *   - Auto-retry has NO advisory lock (DB row-lock during updateStatus
 *     serialises; cron is single-tick anyway)
 *
 * Caller (cron handler T056 extension of reconcile-stuck-sending) is
 * responsible for the eligible-row scan via
 * `BatchManifestsPort.findFailedRetryEligible(...)` — this use case
 * just transitions one batch at a time.
 *
 * Algorithm:
 *   1. updateStatus(batch.id, {status: 'pending', retryCount: cur+1})
 *      The Drizzle adapter's state-machine guard accepts
 *      `failed → pending` (re-queue) per migration 0163 CHECK.
 *   2. Emit `broadcast_retry_initiated` audit with actor='system' +
 *      auto=true distinguisher in payload (vs T047 which emits the
 *      same event with actor=adminUserId).
 *
 * Pure orchestration — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type {
  BatchManifest,
  BatchManifestsPort,
} from '../ports/batch-manifests-port';
import type { ClockPort } from '../ports/clock-port';

export const AUTO_RETRY_BUDGET = 5 as const;
export const AUTO_RETRY_COOLOFF_SECONDS = 900 as const; // 15 minutes

export type AutoRetryFailedBatchesError =
  | { readonly kind: 'BATCH_NOT_RETRY_ELIGIBLE'; readonly reason: string }
  | {
      readonly kind: 'auto_retry_failed_batches.server_error';
      readonly message: string;
    };

export interface AutoRetryFailedBatchesDeps {
  readonly batchManifests: BatchManifestsPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface AutoRetryFailedBatchesInput {
  readonly tenantId: TenantContext;
  readonly batch: BatchManifest;
  readonly requestId?: string | null;
}

export interface AutoRetryFailedBatchesOutput {
  readonly batchManifestId: string;
  readonly batchIndex: number;
  readonly newRetryCount: number;
}

export async function autoRetryFailedBatch(
  deps: AutoRetryFailedBatchesDeps,
  input: AutoRetryFailedBatchesInput,
): Promise<
  Result<AutoRetryFailedBatchesOutput, AutoRetryFailedBatchesError>
> {
  const tenantSlug = input.tenantId.slug;
  const batch = input.batch;

  if (batch.status !== 'failed') {
    return err({
      kind: 'BATCH_NOT_RETRY_ELIGIBLE',
      reason: `expected status='failed', got '${batch.status}'`,
    });
  }
  if (batch.retryCount >= AUTO_RETRY_BUDGET) {
    return err({
      kind: 'BATCH_NOT_RETRY_ELIGIBLE',
      reason: `retry_count ${batch.retryCount} >= budget ${AUTO_RETRY_BUDGET}`,
    });
  }

  const newRetryCount = batch.retryCount + 1;
  const result = await deps.batchManifests.updateStatus(
    tenantSlug,
    batch.id,
    {
      status: 'pending',
      retryCount: newRetryCount,
    },
  );

  if (!result.ok) {
    return err({
      kind: 'auto_retry_failed_batches.server_error',
      message: `updateStatus failed: ${result.error.kind}`,
    });
  }

  await deps.audit.emit(null, {
    tenantId: tenantSlug,
    eventType: 'broadcast_retry_initiated',
    actorUserId: 'system',
    summary: `Auto-retry batch ${batch.batchIndex} of broadcast ${batch.broadcastId as unknown as string} (attempt ${newRetryCount}/${AUTO_RETRY_BUDGET})`,
    payload: {
      broadcastId: batch.broadcastId,
      batchManifestId: batch.id,
      batchIndex: batch.batchIndex,
      retryCount: newRetryCount,
      autoRetryBudget: AUTO_RETRY_BUDGET,
      automated: true,
      previousFailureReason: batch.failureReason,
      retriedAt: deps.clock.now().toISOString(),
    },
    requestId: input.requestId ?? null,
  });

  return ok({
    batchManifestId: batch.id,
    batchIndex: batch.batchIndex,
    newRetryCount,
  });
}

/**
 * Sweep variant — scans eligible failed batches via the port + retries
 * each individually. Used by the reconcile-stuck-sending cron handler
 * extension (Phase 3 T056) AFTER the broadcast-level reconciliation
 * loop completes.
 *
 * Returns a per-batch outcome list + a tally summary. Per-batch
 * failures do NOT abort the sweep (the cron handler logs and
 * continues).
 */
export interface AutoRetrySweepInput {
  readonly tenantId: TenantContext;
  /** Per-tick fan-out cap. Defaults to 100. */
  readonly limit?: number;
  readonly requestId?: string | null;
}

export interface AutoRetrySweepOutcome {
  readonly batchManifestId: string;
  readonly batchIndex: number;
  readonly broadcastId: BroadcastId;
  readonly outcome:
    | { readonly status: 'retried'; readonly newRetryCount: number }
    | { readonly status: 'failed'; readonly error: AutoRetryFailedBatchesError };
}

export interface AutoRetrySweepOutput {
  readonly eligibleCount: number;
  readonly retriedCount: number;
  readonly errorCount: number;
  readonly outcomes: ReadonlyArray<AutoRetrySweepOutcome>;
}

export async function sweepAutoRetryFailedBatches(
  deps: AutoRetryFailedBatchesDeps,
  input: AutoRetrySweepInput,
): Promise<AutoRetrySweepOutput> {
  const eligible = await deps.batchManifests.findFailedRetryEligible(
    input.tenantId.slug,
    {
      retryBudget: AUTO_RETRY_BUDGET,
      cooloffSeconds: AUTO_RETRY_COOLOFF_SECONDS,
      limit: input.limit ?? 100,
    },
  );

  const outcomes: AutoRetrySweepOutcome[] = [];
  let retriedCount = 0;
  let errorCount = 0;

  for (const batch of eligible) {
    const result = await autoRetryFailedBatch(deps, {
      tenantId: input.tenantId,
      batch,
      requestId: input.requestId ?? null,
    });
    if (result.ok) {
      retriedCount++;
      outcomes.push({
        batchManifestId: batch.id,
        batchIndex: batch.batchIndex,
        broadcastId: batch.broadcastId,
        outcome: { status: 'retried', newRetryCount: result.value.newRetryCount },
      });
    } else {
      errorCount++;
      outcomes.push({
        batchManifestId: batch.id,
        batchIndex: batch.batchIndex,
        broadcastId: batch.broadcastId,
        outcome: { status: 'failed', error: result.error },
      });
    }
  }

  return {
    eligibleCount: eligible.length,
    retriedCount,
    errorCount,
    outcomes,
  };
}
