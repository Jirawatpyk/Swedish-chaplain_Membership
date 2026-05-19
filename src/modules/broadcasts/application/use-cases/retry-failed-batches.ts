/**
 * T047 (F7.1a US1) — `retryFailedBatches` Application use case.
 *
 * Admin action: re-queue every batch_manifest stuck in `failed` for a
 * broadcast whose aggregate landed in `partially_sent`. Bounded by a
 * 3-attempt budget on `broadcasts.manual_retry_count` (FR-008a).
 * Related FRs implemented by sibling use cases: FR-008b transient
 * retry state (this file emits both initiated + completed audits);
 * FR-008c accept-partial → `accept-partial-delivery.ts`; FR-008d
 * advisory-lock SC-007 → enforced via `broadcasts-retry:` namespace.
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
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import { type AdvisoryLockPort, asTxToken } from '../ports/advisory-lock-port';
import { logAuditEmitFailure } from '../audit-emit-failure-logger';
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
  const lockKey = makeRetryLockKey(tenantSlug, input.broadcastId);

  // Phase 3E SC-007 hardening — wrap the entire orchestration in a
  // single tx so the advisory-lock acquire shares scope with the
  // snapshot read + increment + batch fan-out + audit emit. Lock auto-
  // releases at tx commit/rollback (`pg_try_advisory_xact_lock`
  // semantics).
  return deps.broadcasts.withTx(async (tx) => {
    // 1. Read broadcast snapshot (cheap; same tx so the snapshot read
    //    sees what subsequent writes will mutate — no torn read).
    const snapshot = await deps.broadcasts.findById(
      tenantSlug,
      input.broadcastId,
      tx,
    );
    if (snapshot === null) {
      // Phase 3F.1 (F-01 fix) — emit cross-tenant probe audit BEFORE
      // returning BROADCAST_NOT_FOUND. Constitution v1.4.0 Principle I
      // sub-clause 4 — every cross-tenant probe MUST leave a forensic
      // trail. Pattern mirrors `enforce-tenant-context.ts:60-78`.
      try {
        await deps.audit.emit(tx, {
          tenantId: tenantSlug,
          eventType: 'broadcast_cross_tenant_probe',
          actorUserId: input.actorUserId,
          summary: `Admin ${input.actorUserId} probed unknown broadcast ${input.broadcastId} (retry path)`,
          payload: {
            broadcastId: input.broadcastId,
            probedBroadcastId: input.broadcastId,
            expectedTenantId: tenantSlug,
            useCase: 'retry-failed-batches',
          },
          requestId: input.requestId ?? null,
        });
      } catch (auditErr) {
        // Phase 3F.11.9 (Round 3 comment-MED) — delegate to canonical
        // helper. See `application/audit-emit-failure-logger.ts` for
        // the Principle I sub-clause 4 rationale.
        logAuditEmitFailure(logger, {
          err: auditErr,
          tenantId: tenantSlug,
          probedBroadcastId: input.broadcastId,
          actorUserId: input.actorUserId,
          useCase: 'retry-failed-batches',
        });
      }
      return err({
        kind: 'BROADCAST_NOT_FOUND',
        broadcastId: input.broadcastId,
      });
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

    // 2. Acquire per-broadcast advisory lock INSIDE the tx. Held until
    //    this withTx callback returns + the outer tx commits.
    //    Concurrent `retryFailedBatches` on the same broadcastId will
    //    see `{acquired: false}` here while our tx holds the lock.
    // Phase 3F.11.6 (Type Bottom #2 partial) — brand the raw tx
    // (typed as `unknown` by `BroadcastsRetryRepo.withTx`'s callback —
    // Step 2 of the migration plan will widen withTx itself) into a
    // `TxToken` at the use-case → port boundary. This is the single
    // line where the brand laundering happens; the port + adapter
    // benefit from compile-time type safety everywhere else.
    const lock = await deps.advisoryLock.acquire(asTxToken(tx), lockKey);
    if (!lock.acquired) {
      return err({
        kind: 'ALREADY_RETRYING_IN_PROGRESS',
        broadcastId: input.broadcastId,
        lockKey,
      });
    }

    // 3. Atomic increment of manual_retry_count INSIDE the locked tx.
    //    DB CHECK still catches budget-exhausted (defence-in-depth);
    //    inside the lock, the snapshot read's value is the canonical
    //    pre-increment count.
    const incResult = await deps.broadcasts.incrementManualRetryCount(
      tenantSlug,
      input.broadcastId,
      tx,
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

    // 4. Emit `broadcast_retry_initiated` INSIDE the locked tx so the
    //    audit row is atomic with the budget increment (no half-state
    //    where the count bumped but the audit trail says it didn't).
    await deps.audit.emit(tx, {
      tenantId: tenantSlug,
      eventType: 'broadcast_retry_initiated',
      actorUserId: input.actorUserId,
      summary: `Admin ${input.actorUserId} initiated retry attempt ${retryAttempt} on broadcast ${input.broadcastId}`,
      payload: {
        broadcastId: input.broadcastId,
        retryAttempt,
        lockKey,
        initiatedAt: now.toISOString(),
        // Phase 3F.7 (F-12 distinguisher) — auto-retry (T056) emits
        // the same eventType with `automated: true`. Explicit `false`
        // here ensures aggregate analytics correctly partition the
        // manual vs auto paths without ambiguity from missing field.
        automated: false,
      },
      requestId: input.requestId ?? null,
    });

    // 5. Re-queue every failed batch_manifest INSIDE the locked tx so
    //    the read + batch updates share snapshot consistency.
    const allBatches = await deps.batchManifests.findByBroadcast(
      tenantSlug,
      input.broadcastId,
      tx,
    );
    const failedBatches = allBatches.filter((b) => b.status === 'failed');

    for (const batch of failedBatches) {
      // Phase 3F.11.1 (C2 — Round 2 fix): rotate idempotency key per
      // manual retry attempt. Without rotation, Resend's deduper
      // short-circuits the resend → 3-attempt manual budget burns to
      // zero with silent no-ops (symmetric to F-04 auto-retry fix from
      // Phase 3F.1 at auto-retry-failed-batches.ts:108). Namespace
      // `-manualretry-N` is disjoint from auto-retry's `-autoretry-N`
      // so an admin retry never collides with a sweep retry on the
      // same batch.
      const rotatedKey = `${batch.idempotencyKey}-manualretry-${retryAttempt}`;
      await deps.batchManifests.updateStatus(
        tenantSlug,
        batch.id,
        {
          status: 'pending',
          retryCount: (batch.retryCount ?? 0) + 1,
          idempotencyKey: rotatedKey,
        },
        tx,
      );
    }

    // 6. Emit `broadcast_retry_completed` — same tx so the entire
    //    retry orchestration is one atomic unit.
    await deps.audit.emit(tx, {
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
  });
}
