/**
 * T047 (F7.1a US1) — `retryFailedBatches` Application use case.
 *
 * Admin action: re-queue every batch_manifest stuck in `failed` for a
 * broadcast whose aggregate landed in `partially_sent`. Bounded by a
 * 3-attempt budget on `broadcasts.manual_retry_count` (FR-008a-d).
 *
 * Concurrency: per-broadcast `pg_advisory_xact_lock` keyed
 *   `broadcasts-retry:{tenantId}:{broadcastId}`
 * (namespace DISJOINT from `broadcasts-batch:` per-batch lock and F7
 * MVP `broadcasts:` lock — see `application/ports/advisory-lock-port.ts`).
 * SC-007 invariant: two simultaneous admin tabs MUST consume the
 * budget at most once.
 *
 * Contract tests:
 *   - T033 retry-failed-batches.test.ts — state guards + budget edge
 *   - T035 concurrent-retry-race.test.ts — advisory-lock SC-007
 *
 * Contract spec: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.3
 *
 * Pure orchestration — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { AdvisoryLockPort } from '../ports/advisory-lock-port';
import type { AuditPort } from '../ports/audit-port';
import type { BatchManifestsPort } from '../ports/batch-manifests-port';
import type { BroadcastsRetryRepo } from '../ports/broadcasts-retry-repo';
import type { ClockPort } from '../ports/clock-port';

export const MANUAL_RETRY_BUDGET = 3 as const;

export type RetryFailedBatchesError =
  | { readonly kind: 'BROADCAST_NOT_FOUND'; readonly broadcastId: BroadcastId }
  | {
      readonly kind: 'INVALID_STATE_TRANSITION';
      readonly currentStatus: string;
      readonly expected: 'partially_sent';
    }
  | {
      readonly kind: 'MANUAL_RETRY_BUDGET_EXHAUSTED';
      readonly broadcastId: BroadcastId;
      readonly budget: typeof MANUAL_RETRY_BUDGET;
    }
  | {
      readonly kind: 'ALREADY_RETRYING_IN_PROGRESS';
      readonly broadcastId: BroadcastId;
      readonly lockKey: string;
    }
  | { readonly kind: 'retry_failed_batches.server_error'; readonly message: string };

export interface RetryFailedBatchesDeps {
  readonly broadcasts: BroadcastsRetryRepo;
  readonly batchManifests: BatchManifestsPort;
  readonly advisoryLock: AdvisoryLockPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export interface RetryFailedBatchesInput {
  readonly tenantId: TenantContext;
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  readonly requestId?: string | null;
}

export interface RetryFailedBatchesOutput {
  /** 1-based post-increment value of `manual_retry_count` (1, 2, or 3). */
  readonly retryAttempt: number;
  /** Number of batch_manifests transitioned from `failed` → `pending`. */
  readonly retriedBatchCount: number;
}

/**
 * Build the per-broadcast advisory-lock key. SC-007: serialise concurrent
 * admin retries; key namespace `broadcasts-retry:` MUST be disjoint from
 * `broadcasts-batch:` (per-batch dispatch lock) and F7 MVP `broadcasts:`.
 */
function makeRetryLockKey(
  tenantSlug: string,
  broadcastId: BroadcastId,
): string {
  return `broadcasts-retry:${tenantSlug}:${broadcastId}`;
}

export async function retryFailedBatches(
  deps: RetryFailedBatchesDeps,
  input: RetryFailedBatchesInput,
): Promise<Result<RetryFailedBatchesOutput, RetryFailedBatchesError>> {
  const tenantSlug = input.tenantId.slug;

  // 1. Read broadcast snapshot (CHEAP read — pre-validate state before
  //    bothering to acquire the advisory lock).
  const snapshot = await deps.broadcasts.findById(
    tenantSlug,
    input.broadcastId,
  );
  if (snapshot === null) {
    return err({ kind: 'BROADCAST_NOT_FOUND', broadcastId: input.broadcastId });
  }

  if (snapshot.status !== 'partially_sent') {
    return err({
      kind: 'INVALID_STATE_TRANSITION',
      currentStatus: snapshot.status,
      expected: 'partially_sent',
    });
  }

  if (snapshot.manualRetryCount >= MANUAL_RETRY_BUDGET) {
    return err({
      kind: 'MANUAL_RETRY_BUDGET_EXHAUSTED',
      broadcastId: input.broadcastId,
      budget: MANUAL_RETRY_BUDGET,
    });
  }

  // 2. Acquire per-broadcast advisory lock (SC-007). Returns
  //    `{acquired: false}` without throwing on contention.
  const lockKey = makeRetryLockKey(tenantSlug, input.broadcastId);
  const lock = await deps.advisoryLock.acquire(lockKey);
  if (!lock.acquired) {
    return err({
      kind: 'ALREADY_RETRYING_IN_PROGRESS',
      broadcastId: input.broadcastId,
      lockKey,
    });
  }

  // 3. Atomic increment of manual_retry_count. The DB CHECK constraint
  //    catches the case where the budget was hit between the snapshot
  //    read and the lock acquire (TOCTOU) — adapter returns
  //    `check_violation` and we map it to BUDGET_EXHAUSTED.
  const incResult = await deps.broadcasts.incrementManualRetryCount(
    tenantSlug,
    input.broadcastId,
  );
  if (!incResult.ok) {
    if (incResult.error.kind === 'check_violation') {
      return err({
        kind: 'MANUAL_RETRY_BUDGET_EXHAUSTED',
        broadcastId: input.broadcastId,
        budget: MANUAL_RETRY_BUDGET,
      });
    }
    if (incResult.error.kind === 'not_found') {
      return err({
        kind: 'BROADCAST_NOT_FOUND',
        broadcastId: input.broadcastId,
      });
    }
    return err({
      kind: 'retry_failed_batches.server_error',
      message: incResult.error.detail,
    });
  }
  const retryAttempt = incResult.value;
  const now = deps.clock.now();

  // 4. Emit `broadcast_retry_initiated` (audit pre-condition for the
  //    re-dispatch sweep). Same `tx` semantics as F7 MVP — null on
  //    auto-commit path; production wrapping in `runInTenant()` may
  //    thread the tx via context.
  await deps.audit.emit(null, {
    tenantId: tenantSlug,
    eventType: 'broadcast_retry_initiated',
    actorUserId: input.actorUserId,
    summary: `Admin ${input.actorUserId} initiated retry attempt ${retryAttempt} on broadcast ${input.broadcastId}`,
    payload: {
      broadcastId: input.broadcastId,
      retryAttempt,
      lockKey,
      initiatedAt: now.toISOString(),
    },
    requestId: input.requestId ?? null,
  });

  // 5. Re-queue every failed batch_manifest. Real dispatcher (T046)
  //    will pick the rows back up on the next cron tick. Here we
  //    transition them `failed → pending` so the dispatcher's pending
  //    sweep finds them again.
  const allBatches = await deps.batchManifests.findByBroadcast(
    tenantSlug,
    input.broadcastId,
  );
  const failedBatches = allBatches.filter((b) => b.status === 'failed');

  for (const batch of failedBatches) {
    await deps.batchManifests.updateStatus(tenantSlug, batch.id, {
      status: 'pending',
      retryCount: (batch.retryCount ?? 0) + 1,
    });
  }

  // 6. Emit `broadcast_retry_completed` — all failed batches have been
  //    re-queued; per-batch ACK from Resend lands as `broadcast_sent`
  //    events via the webhook handler (Phase 3C T057).
  await deps.audit.emit(null, {
    tenantId: tenantSlug,
    eventType: 'broadcast_retry_completed',
    actorUserId: input.actorUserId,
    summary: `Retry attempt ${retryAttempt} requeued ${failedBatches.length} failed batches on broadcast ${input.broadcastId}`,
    payload: {
      broadcastId: input.broadcastId,
      retryAttempt,
      retriedBatchCount: failedBatches.length,
      retriedAt: now.toISOString(),
    },
    requestId: input.requestId ?? null,
  });

  return ok({
    retryAttempt,
    retriedBatchCount: failedBatches.length,
  });
}
