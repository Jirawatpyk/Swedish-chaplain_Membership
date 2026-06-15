/**
 * Ship-blocker A — unit test for the batch-completion roll-up.
 *
 * The F7.1a batch lifecycle had NO code that rolls a multi-batch
 * broadcast out of `sending`: recordPartialSend had 0 callers and the
 * batch→sent roll-up was "deferred to Phase 3 Cluster 3D" and never
 * built, so a >10k broadcast stayed in `sending` forever. This pins:
 *   - the pure `evaluateBatchCompletion` predicate (done / failed)
 *   - the use-case: all batches done + none failed → sent (+ quota);
 *     all done + ≥1 failed → partially_sent; not all done → in_progress;
 *     not `sending` / no batches → skipped.
 */
import { describe, expect, it } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import {
  evaluateBatchCompletion,
  rollUpBatchBroadcast,
} from '@/modules/broadcasts/application/use-cases/roll-up-batch-broadcast';
import type { BatchManifest } from '@/modules/broadcasts/application/ports/batch-manifests-port';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';

const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

function batch(overrides: Partial<BatchManifest> = {}): BatchManifest {
  return {
    id: 'b-1',
    tenantId: 'test-tenant' as never,
    broadcastId,
    batchIndex: 0,
    recipientCount: 100,
    recipientRangeStart: 0,
    recipientRangeEnd: 99,
    status: 'sending',
    providerAudienceId: 'aud',
    providerBroadcastId: 'pbid',
    idempotencyKey: 'k' as never,
    retryCount: 0,
    deliveredCount: 0,
    bouncedCount: 0,
    complainedCount: 0,
    unsubscribedCount: 0,
    dispatchedAt: new Date(),
    failedAt: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('evaluateBatchCompletion (Ship-blocker A)', () => {
  it('empty → not allDone', () => {
    expect(evaluateBatchCompletion([])).toEqual({
      allDone: false,
      anyFailed: false,
      failedBatchIds: [],
    });
  });

  it('counters reach recipient_count → done (even while status sending)', () => {
    const r = evaluateBatchCompletion([
      batch({ deliveredCount: 98, bouncedCount: 2 }), // 100 of 100
    ]);
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(false);
  });

  it('one batch short of recipient_count → not allDone', () => {
    const r = evaluateBatchCompletion([
      batch({ id: 'b-1', deliveredCount: 100 }),
      batch({ id: 'b-2', deliveredCount: 50 }), // 50 of 100
    ]);
    expect(r.allDone).toBe(false);
  });

  it('failed batch with retry budget exhausted (retry_count=5) → done + failed', () => {
    const r = evaluateBatchCompletion([
      batch({ id: 'b-1', deliveredCount: 100 }),
      batch({ id: 'b-2', status: 'failed', retryCount: 5, deliveredCount: 0 }),
    ]);
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(true);
    expect(r.failedBatchIds).toEqual(['b-2']);
  });

  it('failed batch still retry-eligible (retry_count<5) → NOT done (in_progress)', () => {
    const r = evaluateBatchCompletion([
      batch({ id: 'b-1', deliveredCount: 100 }),
      batch({ id: 'b-2', status: 'failed', retryCount: 2, deliveredCount: 0 }),
    ]);
    expect(r.allDone).toBe(false);
  });

  it('cancelled batch → done but not a clean sent (counts toward partially_sent)', () => {
    const r = evaluateBatchCompletion([
      batch({ id: 'b-1', deliveredCount: 100 }),
      batch({ id: 'b-2', status: 'cancelled', deliveredCount: 0 }),
    ]);
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(true);
  });

  it('forceComplete (24h backstop) → still-sending done; retry-eligible failed → failed', () => {
    const r = evaluateBatchCompletion(
      [
        batch({ id: 'b-1', status: 'sending', deliveredCount: 30 }),
        batch({ id: 'b-2', status: 'failed', retryCount: 1, deliveredCount: 0 }),
      ],
      { forceComplete: true },
    );
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(true);
    expect(r.failedBatchIds).toEqual(['b-2']);
  });
});

interface StubOpts {
  readonly status?: BatchManifest['status'] | 'not-sending';
  readonly batches?: BatchManifest[];
  readonly throwConcurrent?: boolean;
}

function makeDeps(opts: StubOpts = {}) {
  const transitions: Array<{ target: string; fields: Record<string, unknown> }> =
    [];
  const emits: Array<{ eventType: string }> = [];
  const broadcastStatus =
    opts.status === 'not-sending' ? 'approved' : 'sending';
  return {
    transitions,
    emits,
    deps: {
      tenant,
      clock: { now: () => new Date('2026-06-15T06:00:00Z') },
      broadcastsRepo: {
        async findById() {
          return {
            broadcastId,
            status: broadcastStatus,
            requestedByMemberId: 'm-1',
            subject: 'x',
            estimatedRecipientCount: 100,
          };
        },
        async withTx<T>(fn: (tx: unknown) => Promise<T>) {
          return fn({});
        },
        async applyTransition(
          _tx: unknown,
          _t: unknown,
          _id: unknown,
          target: string,
          fields: Record<string, unknown>,
        ) {
          if (opts.throwConcurrent) {
            throw new BroadcastConcurrentMutationError(
              tenant.slug,
              broadcastId,
              'sent',
            );
          }
          transitions.push({ target, fields });
          return {};
        },
      },
      batchManifests: {
        async findByBroadcast() {
          return opts.batches ?? [];
        },
      },
      audit: {
        async emit(_tx: unknown, e: { eventType: string }) {
          emits.push(e);
        },
      },
    },
  };
}

describe('rollUpBatchBroadcast (Ship-blocker A)', () => {
  it('not sending → skipped, no transition', async () => {
    const { deps, transitions } = makeDeps({ status: 'not-sending' });
    const r = await rollUpBatchBroadcast(deps as never, {
      broadcastId,
      requestId: null,
    });
    expect(r.ok).toBe(true);
    expect(transitions).toHaveLength(0);
  });

  it('no batches → skipped (single-audience)', async () => {
    const { deps, transitions } = makeDeps({ batches: [] });
    await rollUpBatchBroadcast(deps as never, { broadcastId, requestId: null });
    expect(transitions).toHaveLength(0);
  });

  it('all batches done, none failed → sent + quota consumed', async () => {
    const { deps, transitions, emits } = makeDeps({
      batches: [batch({ deliveredCount: 100 })],
    });
    const r = await rollUpBatchBroadcast(deps as never, {
      broadcastId,
      requestId: null,
    });
    expect(r.ok).toBe(true);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.target).toBe('sent');
    expect(transitions[0]?.fields['quotaYearConsumed']).toBe(2026);
    expect(emits.some((e) => e.eventType === 'broadcast_sent')).toBe(true);
    expect(emits.some((e) => e.eventType === 'broadcast_quota_consumed')).toBe(
      true,
    );
  });

  it('all done, ≥1 failed → partially_sent (no quota field)', async () => {
    const { deps, transitions } = makeDeps({
      batches: [
        batch({ id: 'b-1', deliveredCount: 100 }),
        batch({ id: 'b-2', status: 'failed', retryCount: 5 }),
      ],
    });
    const r = await rollUpBatchBroadcast(deps as never, {
      broadcastId,
      requestId: null,
    });
    expect(r.ok).toBe(true);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.target).toBe('partially_sent');
    expect(transitions[0]?.fields['quotaYearConsumed']).toBeUndefined();
  });

  it('not all done → in_progress, no transition', async () => {
    const { deps, transitions } = makeDeps({
      batches: [batch({ deliveredCount: 50 })],
    });
    await rollUpBatchBroadcast(deps as never, { broadcastId, requestId: null });
    expect(transitions).toHaveLength(0);
  });

  it('cooling-off failed batch (retry<5) → in_progress, no transition (B-1)', async () => {
    const { deps, transitions } = makeDeps({
      batches: [
        batch({ id: 'b-1', deliveredCount: 100 }),
        batch({ id: 'b-2', status: 'failed', retryCount: 2 }),
      ],
    });
    const r = await rollUpBatchBroadcast(deps as never, {
      broadcastId,
      requestId: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('in_progress');
    expect(transitions).toHaveLength(0);
  });

  it('concurrent transition out of sending → skipped, not error (M-2)', async () => {
    const { deps, transitions } = makeDeps({
      batches: [batch({ deliveredCount: 100 })],
      throwConcurrent: true,
    });
    const r = await rollUpBatchBroadcast(deps as never, {
      broadcastId,
      requestId: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('skipped');
    expect(transitions).toHaveLength(0);
  });
});
