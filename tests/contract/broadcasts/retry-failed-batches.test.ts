/**
 * T033 — Contract test: `retryFailedBatches` use case (US1 / FR-008a..d).
 *
 * Authored RED 2026-05-19 per Constitution II NON-NEG TDD. Phase 3
 * Cluster B implements at:
 *   src/modules/broadcasts/application/use-cases/retry-failed-batches.ts
 *
 * Contract spec: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.3
 *
 * Preconditions:
 *   - Broadcast must be in `partially_sent` state
 *   - `manual_retry_count` must be < 3
 *
 * Cases covered:
 *   - Retry from `partially_sent` with budget remaining → succeeds;
 *     emits `broadcast_retry_initiated` + `broadcast_retry_completed`
 *   - Retry from `partially_sent` with budget=3 exhausted → returns
 *     `MANUAL_RETRY_BUDGET_EXHAUSTED` error
 *   - Retry from `sent` (terminal) → returns `INVALID_STATE_TRANSITION`
 *
 * Per-broadcast advisory lock (`broadcasts-retry:` namespace) is
 * exercised separately by T035 concurrent-retry-race.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { retryFailedBatches } from '@/modules/broadcasts/application/use-cases/retry-failed-batches';

/**
 * Phase 3 Cluster B GREEN (2026-05-19) — T047 use case landed at
 *   src/modules/broadcasts/application/use-cases/retry-failed-batches.ts
 *
 * Earlier RED variant imported via `new Function('m','return import(m)')`
 * to bypass Vite's static alias resolution. Static import now.
 */
async function importRetryUseCase(): Promise<{
  retryFailedBatches: (
    deps: unknown,
    input: unknown,
  ) => ReturnType<typeof retryFailedBatches>;
}> {
  return {
    retryFailedBatches: (deps, input) =>
      retryFailedBatches(deps as never, input as never),
  };
}

const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('22222222-2222-2222-2222-222222222222');
const actorUserId = 'admin-user-1';

type BroadcastFixture = {
  status: 'partially_sent' | 'sent' | 'draft';
  manualRetryCount: number;
  failedBatchIds: string[];
};

function makeStubDeps(broadcast: BroadcastFixture): {
  emits: Array<{ eventType: string }>;
  manualRetryCountAfter: () => number;
  statusUpdates: Array<{ batchId: string; update: { status: string; retryCount?: number; idempotencyKey?: string } }>;
  deps: unknown;
} {
  const emits: Array<{ eventType: string }> = [];
  const statusUpdates: Array<{ batchId: string; update: { status: string; retryCount?: number; idempotencyKey?: string } }> = [];
  let manualRetryCount = broadcast.manualRetryCount;

  return {
    emits,
    manualRetryCountAfter: () => manualRetryCount,
    statusUpdates,
    deps: {
      audit: {
        async emit(_tx: unknown, e: { eventType: string }) {
          emits.push(e);
        },
      },
      broadcasts: {
        async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
          return fn('mock-tx');
        },
        async findById(_t: unknown, _id: unknown, _tx?: unknown) {
          return {
            tenantId: 'test-tenant',
            broadcastId,
            status: broadcast.status,
            manualRetryCount,
          };
        },
        async incrementManualRetryCount(
          _t: unknown,
          _id: unknown,
          _tx?: unknown,
        ) {
          if (manualRetryCount >= 3) {
            return { ok: false, error: { kind: 'check_violation' as const } };
          }
          manualRetryCount += 1;
          return { ok: true, value: manualRetryCount };
        },
      },
      batchManifests: {
        async findByBroadcast(_t: unknown, _id: unknown, _tx?: unknown) {
          return broadcast.failedBatchIds.map((id, i) => ({
            id,
            batchIndex: i,
            status: 'failed' as const,
            // Phase 3F.11.1 (C2) — manifests carry an idempotencyKey
            // that the use case MUST rotate on retry. The stub now
            // provides the field so the test can assert rotation.
            idempotencyKey: `broadcast-22222222-batch-${i}-attempt-0`,
            retryCount: 0,
          }));
        },
        async updateStatus(
          _t: unknown,
          id: unknown,
          update: { status: string; retryCount?: number; idempotencyKey?: string },
          _tx?: unknown,
        ) {
          statusUpdates.push({ batchId: id as string, update });
          return { ok: true, value: {} };
        },
      },
      advisoryLock: {
        async acquire(_tx: unknown, _lockKey: string) {
          return { acquired: true };
        },
      },
      clock: { now: () => new Date('2026-06-15T05:00:00Z') },
    },
  };
}

describe('retryFailedBatches contract (T033)', () => {
  it('partially_sent + budget=0 (first retry) → succeeds; emits retry_initiated + retry_completed', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    const { deps, emits, manualRetryCountAfter } = makeStubDeps({
      status: 'partially_sent',
      manualRetryCount: 0,
      failedBatchIds: ['batch-3', 'batch-7'],
    });

    const result = await retryFailedBatches(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { retryAttempt: number; retriedBatchCount: number };
    expect(value.retryAttempt).toBe(1);
    expect(value.retriedBatchCount).toBe(2);
    expect(manualRetryCountAfter()).toBe(1);
    expect(emits.find((e) => e.eventType === 'broadcast_retry_initiated')).toBeDefined();
    expect(emits.find((e) => e.eventType === 'broadcast_retry_completed')).toBeDefined();
  });

  it('partially_sent + budget=2 → 3rd retry succeeds (post-increment to 3)', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    const { deps, manualRetryCountAfter } = makeStubDeps({
      status: 'partially_sent',
      manualRetryCount: 2,
      failedBatchIds: ['batch-1'],
    });

    const result = await retryFailedBatches(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect((result.value as { retryAttempt: number }).retryAttempt).toBe(3);
    expect(manualRetryCountAfter()).toBe(3);
  });

  it('partially_sent + budget=3 (exhausted) → returns MANUAL_RETRY_BUDGET_EXHAUSTED', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    const { deps, manualRetryCountAfter } = makeStubDeps({
      status: 'partially_sent',
      manualRetryCount: 3,
      failedBatchIds: ['batch-1'],
    });

    const result = await retryFailedBatches(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('MANUAL_RETRY_BUDGET_EXHAUSTED');
    // Budget NOT consumed on rejection — invariant from FR-008a
    expect(manualRetryCountAfter()).toBe(3);
  });

  it('from sent (terminal) → returns INVALID_STATE_TRANSITION', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    const { deps } = makeStubDeps({
      status: 'sent',
      manualRetryCount: 0,
      failedBatchIds: [],
    });

    const result = await retryFailedBatches(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('INVALID_STATE_TRANSITION');
  });

  it('from draft → returns INVALID_STATE_TRANSITION (only partially_sent allowed)', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    const { deps } = makeStubDeps({
      status: 'draft',
      manualRetryCount: 0,
      failedBatchIds: [],
    });

    const result = await retryFailedBatches(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('INVALID_STATE_TRANSITION');
  });

  // Phase 3F.11.1 (C2 — Round 2 fix) — manual-retry idempotency-key
  // rotation. Symmetric to the Phase 3F.1 F-04 auto-retry fix; without
  // rotation Resend's deduper short-circuits the resend → manual budget
  // burns to zero with silent no-ops.
  it('manual retry rotates idempotencyKey with -manualretry-N suffix on every failed batch', async () => {
    const { retryFailedBatches } = await importRetryUseCase();
    const { deps, statusUpdates } = makeStubDeps({
      status: 'partially_sent',
      manualRetryCount: 0,
      failedBatchIds: ['batch-2', 'batch-5'],
    });

    const result = await retryFailedBatches(deps, {
      tenantId: tenant,
      broadcastId,
      actorUserId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    // 2 batches re-queued → 2 updateStatus calls
    expect(statusUpdates).toHaveLength(2);

    // Each carries a rotated idempotencyKey with -manualretry-1 suffix
    // (retryAttempt=1 because manualRetryCount started at 0).
    expect(statusUpdates[0]?.update.idempotencyKey).toBe(
      'broadcast-22222222-batch-0-attempt-0-manualretry-1',
    );
    expect(statusUpdates[1]?.update.idempotencyKey).toBe(
      'broadcast-22222222-batch-1-attempt-0-manualretry-1',
    );

    // Disjoint namespace from auto-retry (-autoretry-N) verified by the
    // literal `-manualretry-` substring presence.
    for (const u of statusUpdates) {
      expect(u.update.idempotencyKey).toMatch(/-manualretry-1$/);
      expect(u.update.idempotencyKey).not.toMatch(/-autoretry-/);
    }
  });
});
