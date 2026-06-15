/**
 * Phase 3F.5 (2026-05-19) — Contract test for `autoRetryFailedBatch`
 * + `sweepAutoRetryFailedBatches` (T056). Closes pr-test-analyzer
 * Findings 6 + 7: budget boundary (count=4 → 5) edge case + sweep
 * behavior under mixed eligible/ineligible/error inputs.
 */
import { describe, expect, it } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asIdempotencyKey } from '@/modules/broadcasts/domain/value-objects/idempotency-key';
import {
  autoRetryFailedBatch,
  sweepAutoRetryFailedBatches,
  AUTO_RETRY_BUDGET,
} from '@/modules/broadcasts/application/use-cases/auto-retry-failed-batches';
import type { BatchManifest } from '@/modules/broadcasts/application/ports/batch-manifests-port';
import type { TenantSlug } from '@/modules/tenants';

const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

function makeBatch(overrides: Partial<BatchManifest> = {}): BatchManifest {
  return {
    id: 'b-1',
    tenantId: 'test-tenant' as TenantSlug,
    broadcastId,
    batchIndex: 0,
    recipientCount: 100,
    recipientRangeStart: 0,
    recipientRangeEnd: 99,
    status: 'failed',
    providerAudienceId: 'aud-1',
    providerBroadcastId: 'resend-bid-1',
    idempotencyKey: asIdempotencyKey('broadcast-aaa-batch-0-attempt-0'),
    retryCount: 0,
    deliveredCount: 0,
    bouncedCount: 0,
    complainedCount: 0,
    unsubscribedCount: 0,
    dispatchedAt: new Date('2026-06-15T05:00:00Z'),
    failedAt: new Date('2026-06-15T05:00:00Z'),
    failureReason: 'rate_limit',
    createdAt: new Date('2026-06-15T05:00:00Z'),
    updatedAt: new Date('2026-06-15T05:00:00Z'),
    ...overrides,
  };
}

function makeStubDeps(opts: {
  eligibleBatches?: BatchManifest[];
  updateFails?: boolean;
  /** Make updateStatus THROW (not return Result-err) for this batch id. */
  updateThrowsOnId?: string;
} = {}): {
  emits: Array<{ eventType: string; payload?: unknown }>;
  updates: Array<{ status: string; retryCount?: number; idempotencyKey?: string }>;
  deps: unknown;
} {
  const emits: Array<{ eventType: string; payload?: unknown }> = [];
  const updates: Array<{ status: string; retryCount?: number; idempotencyKey?: string }> = [];

  return {
    emits,
    updates,
    deps: {
      batchManifests: {
        async findFailedRetryEligible() {
          return opts.eligibleBatches ?? [];
        },
        async updateStatus(_t: unknown, id: unknown, update: { status: string; retryCount?: number; idempotencyKey?: string }) {
          updates.push(update);
          if (
            opts.updateThrowsOnId !== undefined &&
            id === opts.updateThrowsOnId
          ) {
            // Simulate the uncaught throw path: updateStatus's outer
            // withTxOr/runInTenant scope can throw (tx-open / connection
            // drop / serialization error) rather than return a Result-err.
            throw new Error('simulated tx-open failure (connection drop)');
          }
          if (opts.updateFails) {
            return {
              ok: false,
              error: { kind: 'storage_error' as const, detail: 'simulated' },
            };
          }
          return { ok: true, value: makeBatch() };
        },
      },
      audit: {
        async emit(_tx: unknown, e: { eventType: string; payload?: unknown }) {
          emits.push(e);
        },
      },
      clock: { now: () => new Date('2026-06-15T06:00:00Z') },
    },
  };
}

describe('autoRetryFailedBatch + sweepAutoRetryFailedBatches contract (Phase 3F.5)', () => {
  it('retryCount=4 (last attempt) → succeeds, post-increments to 5', async () => {
    const batch = makeBatch({ retryCount: 4 });
    const { deps, updates } = makeStubDeps();
    const result = await autoRetryFailedBatch(deps as never, {
      tenantId: tenant,
      batch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.newRetryCount).toBe(5);
    expect(updates[0]?.retryCount).toBe(5);
    // Phase 3F.1 F-04 — idempotency key rotated
    expect(updates[0]?.idempotencyKey).toBe('broadcast-aaa-batch-0-attempt-0-autoretry-5');
  });

  it(`retryCount=${AUTO_RETRY_BUDGET} (at budget) → BATCH_NOT_RETRY_ELIGIBLE`, async () => {
    const batch = makeBatch({ retryCount: AUTO_RETRY_BUDGET });
    const { deps, updates } = makeStubDeps();
    const result = await autoRetryFailedBatch(deps as never, {
      tenantId: tenant,
      batch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { kind: string }).kind).toBe('BATCH_NOT_RETRY_ELIGIBLE');
    expect(updates).toHaveLength(0); // no DB write
  });

  it('batch.status !== "failed" → BATCH_NOT_RETRY_ELIGIBLE with reason', async () => {
    const batch = makeBatch({ status: 'sending' });
    const { deps } = makeStubDeps();
    const result = await autoRetryFailedBatch(deps as never, {
      tenantId: tenant,
      batch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as { kind: string }).kind).toBe('BATCH_NOT_RETRY_ELIGIBLE');
    expect((result.error as { reason: string }).reason).toContain('status');
  });

  it('sweep: empty eligible → zero outcomes', async () => {
    const { deps } = makeStubDeps({ eligibleBatches: [] });
    const result = await sweepAutoRetryFailedBatches(deps as never, {
      tenantId: tenant,
    });
    expect(result.eligibleCount).toBe(0);
    expect(result.retriedCount).toBe(0);
    expect(result.outcomes).toEqual([]);
  });

  it('sweep: mix of eligible batches → each retried; per-batch results aggregated', async () => {
    const eligible = [
      makeBatch({ id: 'b-1', retryCount: 0 }),
      makeBatch({ id: 'b-2', retryCount: 3 }),
      makeBatch({ id: 'b-3', retryCount: 4 }),
    ];
    const { deps } = makeStubDeps({ eligibleBatches: eligible });
    const result = await sweepAutoRetryFailedBatches(deps as never, {
      tenantId: tenant,
    });
    expect(result.eligibleCount).toBe(3);
    expect(result.retriedCount).toBe(3);
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes.every((o) => o.outcome.status === 'retried')).toBe(true);
  });

  it('sweep: a THROW from one batch does NOT abort the sweep — remaining batches still retried (F7-SF-2)', async () => {
    const eligible = [
      makeBatch({ id: 'b-1', retryCount: 0 }),
      makeBatch({ id: 'b-2', retryCount: 0 }), // updateStatus throws here
      makeBatch({ id: 'b-3', retryCount: 0 }),
    ];
    const { deps, updates } = makeStubDeps({
      eligibleBatches: eligible,
      updateThrowsOnId: 'b-2',
    });
    // Pre-fix this REJECTS (the throw propagates out of the loop) and b-3
    // is never reached. Post-fix the sweep resolves and processes all 3.
    const result = await sweepAutoRetryFailedBatches(deps as never, {
      tenantId: tenant,
    });
    expect(result.eligibleCount).toBe(3);
    expect(result.retriedCount).toBe(2); // b-1 + b-3
    expect(result.errorCount).toBe(1); // b-2 throw → failed outcome
    expect(result.outcomes).toHaveLength(3);
    const b2 = result.outcomes.find((o) => o.batchManifestId === 'b-2');
    expect(b2?.outcome.status).toBe('failed');
    const b3 = result.outcomes.find((o) => o.batchManifestId === 'b-3');
    expect(b3?.outcome.status).toBe('retried'); // reached despite b-2 throw
    // updateStatus was attempted for all 3 — proves the loop did not abort.
    expect(updates).toHaveLength(3);
  });
});
