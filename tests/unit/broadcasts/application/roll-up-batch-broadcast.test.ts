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

  it('forceComplete (24h backstop): a sending batch that never reached its counters is PARTIAL, not clean (E)', () => {
    const r = evaluateBatchCompletion(
      [
        batch({ id: 'b-1', status: 'sending', deliveredCount: 30 }),
        batch({ id: 'b-2', status: 'failed', retryCount: 1, deliveredCount: 0 }),
      ],
      { forceComplete: true },
    );
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(true);
    // E — b-1 only confirmed 30/100 delivery events; force-give-up must count
    // it toward partially_sent (we cannot claim a clean send + burn quota).
    expect(r.failedBatchIds).toEqual(['b-1', 'b-2']);
  });

  it('forceComplete: a sending batch that DID reach its counters stays a clean sent (E control)', () => {
    const r = evaluateBatchCompletion(
      [batch({ id: 'b-1', status: 'sending', deliveredCount: 100 })],
      { forceComplete: true },
    );
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(false);
  });

  it('A — unsubscribed is a post-delivery event and must NOT count toward completion (no over-count)', () => {
    // 60 recipients delivered; 40 of those 60 later unsubscribe. One recipient
    // can bump two counters, so summing unsubscribed would falsely reach 100.
    // Mirrors the single-audience formula (delivered+bounced+complained).
    const r = evaluateBatchCompletion([
      batch({ deliveredCount: 60, unsubscribedCount: 40 }), // 60 real of 100
    ]);
    expect(r.allDone).toBe(false);
  });

  it('B — a failed batch whose counters reached recipient_count is NOT a clean done (retry<budget → in_progress)', () => {
    const r = evaluateBatchCompletion([
      batch({ status: 'failed', retryCount: 2, deliveredCount: 100 }),
    ]);
    expect(r.allDone).toBe(false);
  });

  it('B — a failed batch with full counters AND budget exhausted → done + partial', () => {
    const r = evaluateBatchCompletion([
      batch({ status: 'failed', retryCount: 5, deliveredCount: 100 }),
    ]);
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(true);
  });

  it('C — a 0-recipient batch never counter-completes (no silent sent + quota burn)', () => {
    const r = evaluateBatchCompletion([
      batch({ recipientCount: 0, deliveredCount: 0 }),
    ]);
    expect(r.allDone).toBe(false);
  });

  it('D — a pending batch under forceComplete rolls up as partial (never dispatched), not stuck forever', () => {
    const r = evaluateBatchCompletion(
      [batch({ status: 'pending', deliveredCount: 0 })],
      { forceComplete: true },
    );
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(true);
    expect(r.failedBatchIds).toEqual(['b-1']);
  });

  it('D — a pending batch WITHOUT forceComplete keeps the broadcast in_progress (not done)', () => {
    const r = evaluateBatchCompletion([
      batch({ status: 'pending', deliveredCount: 0 }),
    ]);
    expect(r.allDone).toBe(false);
  });

  it('D — a pending batch with STALE full counters (failed→pending re-queue) still terminalizes under force, not stuck (Low-1)', () => {
    // A batch can be `pending` while carrying counters from a PRIOR
    // dispatch attempt (auto-retry re-queues failed→pending without
    // zeroing counters). `pending` means "not currently dispatched", so
    // under the 24h backstop it must give up as partial — never clean,
    // and never stuck waiting on counters that won't advance.
    const r = evaluateBatchCompletion(
      [batch({ status: 'pending', deliveredCount: 100 })],
      { forceComplete: true },
    );
    expect(r.allDone).toBe(true);
    expect(r.anyFailed).toBe(true);
    expect(r.failedBatchIds).toEqual(['b-1']);
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

  it('all done, ≥1 failed → partially_sent (no quota field) + emits broadcast_partially_sent (F)', async () => {
    const { deps, transitions, emits } = makeDeps({
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
    // review-fix F — dedicated event, NOT the 24h timeout event.
    expect(emits.some((e) => e.eventType === 'broadcast_partially_sent')).toBe(
      true,
    );
    expect(
      emits.some((e) => e.eventType === 'broadcast_send_timeout_completed'),
    ).toBe(false);
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

  it('zero-recipient batch → in_progress, no transition (no quota burn) (C)', async () => {
    const { deps, transitions, emits } = makeDeps({
      batches: [batch({ recipientCount: 0, deliveredCount: 0 })],
    });
    const r = await rollUpBatchBroadcast(deps as never, {
      broadcastId,
      requestId: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('in_progress');
    expect(transitions).toHaveLength(0);
    expect(emits.some((e) => e.eventType === 'broadcast_quota_consumed')).toBe(
      false,
    );
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
