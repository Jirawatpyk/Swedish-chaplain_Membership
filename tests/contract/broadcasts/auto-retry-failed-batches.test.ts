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
        async updateStatus(_t: unknown, _id: unknown, update: { status: string; retryCount?: number; idempotencyKey?: string }) {
          updates.push(update);
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
});
