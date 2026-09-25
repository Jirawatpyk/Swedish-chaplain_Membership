/**
 * F7 retention sweep (migration 0310) — `sweepExpiredBroadcasts`.
 *
 * Pins the loop (bounded batches, one transaction each, a wall-clock budget
 * checked between batches), the image stamp that co-commits with each batch,
 * and the ONE counts-only `broadcast_retention_swept` row per run.
 *
 * What the repository selects (terminal, past the anchor + retention_years,
 * no live Resend audience) and that the children leave by cascade is proven
 * against live Postgres in
 * `tests/integration/broadcasts/broadcast-retention-sweep.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  sweepExpiredBroadcasts,
  type SweepExpiredBroadcastsDeps,
} from '@/modules/broadcasts/application/use-cases/sweep-expired-broadcasts';
import type { BroadcastImageRecord } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import { asTenantContext } from '@/modules/tenants';

const tenant = asTenantContext('test-tenant');
const NOW = new Date('2031-06-15T20:50:00.000Z');
const TX = Symbol('batch-tx');

type Swept = { broadcastId: string; requestedByMemberId: string | null };

function imageOf(ownerId: string, n: number): BroadcastImageRecord {
  return {
    id: `img-${ownerId}-${n}`,
    tenantId: 'test-tenant',
    ownerKind: 'broadcast',
    ownerId,
    contentHash: `hash-${ownerId}-${n}`,
    blobUrl: `https://blob.example/${ownerId}/${n}`,
    blobKey: `k/${ownerId}/${n}`,
    mimeType: 'image/png',
    byteSize: 10,
    uploadedByUserId: 'u-1',
    createdAt: NOW,
    deletedAt: NOW,
  };
}

function makeDeps(opts: {
  /** Expired rows the fake serves `limit` at a time, oldest first. */
  expired?: number;
  /** Throw on this (1-based) repo call. */
  throwOnCall?: number;
  /** Images per swept broadcast. */
  imagesPerRow?: number;
  /** Advance the clock by this much on every read after the first. */
  tickMs?: number;
  auditThrows?: boolean;
  timeBudgetMs?: number;
  batchSize?: number;
}) {
  let remaining = opts.expired ?? 0;
  let served = 0;
  let calls = 0;
  let clockReads = 0;
  const repoCalls: Array<{ tenantId: string; now: Date; limit: number; tx: unknown }> = [];
  const txOpened: number[] = [];

  const deleteExpiredForRetention = vi.fn(
    async (tenantId: string, now: Date, limit: number, tx: unknown): Promise<{ swept: readonly Swept[] }> => {
      calls += 1;
      repoCalls.push({ tenantId, now, limit, tx });
      if (opts.throwOnCall === calls) throw new Error('Neon: connection terminated');
      const take = Math.min(limit, remaining);
      remaining -= take;
      const swept = Array.from({ length: take }, () => {
        served += 1;
        return { broadcastId: `bc-${served}`, requestedByMemberId: served % 2 === 0 ? `m-${served}` : null };
      });
      return { swept };
    },
  );

  const markDeletedByOwners = vi.fn(
    async (_t: string, _kind: string, ownerIds: readonly string[]): Promise<readonly BroadcastImageRecord[]> =>
      ownerIds.flatMap((id) => Array.from({ length: opts.imagesPerRow ?? 0 }, (_v, n) => imageOf(id, n))),
  );

  const emitTyped = vi.fn(async (_tx: unknown, event: { eventType: string }) => {
    if (opts.auditThrows && event.eventType === 'broadcast_retention_swept') throw new Error('audit down');
  });

  const deps: SweepExpiredBroadcastsDeps = {
    tenant,
    broadcastsRepo: {
      async withTx(fn) {
        txOpened.push(txOpened.length + 1);
        return fn(TX);
      },
      deleteExpiredForRetention,
    },
    imagesRepo: { markDeletedByOwners },
    audit: { emit: vi.fn(async () => undefined), emitTyped } as never,
    clock: {
      now: () => {
        const at = new Date(NOW.getTime() + clockReads * (opts.tickMs ?? 0));
        clockReads += 1;
        return at;
      },
    },
    requestId: 'cron-retention-test',
    ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
    ...(opts.timeBudgetMs !== undefined ? { timeBudgetMs: opts.timeBudgetMs } : {}),
  };
  return { deps, repoCalls, txOpened, markDeletedByOwners, emitTyped };
}

function runAudits(emitTyped: ReturnType<typeof vi.fn>) {
  return emitTyped.mock.calls
    .map((c) => c[1] as { eventType: string; payload: Record<string, unknown>; actorUserId: string })
    .filter((e) => e.eventType === 'broadcast_retention_swept');
}

describe('sweepExpiredBroadcasts', () => {
  it('zero rows: one batch, nothing stamped, and still ONE run row saying 0', async () => {
    const { deps, repoCalls, markDeletedByOwners, emitTyped } = makeDeps({ expired: 0 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result).toEqual({
      ok: true,
      value: { sweptCount: 0, imagesMarked: 0, batches: 1, budgetExhausted: false },
    });
    expect(repoCalls).toHaveLength(1);
    expect(repoCalls[0]).toEqual({ tenantId: 'test-tenant', now: NOW, limit: 200, tx: TX });
    expect(markDeletedByOwners).not.toHaveBeenCalled();
    const audits = runAudits(emitTyped);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toEqual({
      swept_count: 0,
      images_marked: 0,
      batches: 1,
      budget_exhausted: false,
      completed: true,
      actor_role: 'system',
    });
  });

  it('batches of 200 until a short batch, one transaction per batch (+1 for the run row)', async () => {
    const { deps, repoCalls, txOpened, emitTyped } = makeDeps({ expired: 450 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toEqual({
      sweptCount: 450,
      imagesMarked: 0,
      batches: 3,
      budgetExhausted: false,
    });
    expect(repoCalls.map((c) => c.limit)).toEqual([200, 200, 200]);
    expect(txOpened).toHaveLength(4);
    expect(runAudits(emitTyped)[0]?.payload).toMatchObject({ swept_count: 450, batches: 3 });
  });

  it('an exact multiple of the batch size costs one more (empty) batch, never an extra row', async () => {
    const { deps, repoCalls } = makeDeps({ expired: 400 });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value.sweptCount).toBe(400);
    expect(repoCalls).toHaveLength(3);
  });

  it('stops on the time budget between batches and says so', async () => {
    // Every clock read is 30 s later; the budget is 45 s.
    const { deps, repoCalls, emitTyped } = makeDeps({ expired: 1000, tickMs: 30_000, timeBudgetMs: 45_000 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toEqual({
      sweptCount: 400,
      imagesMarked: 0,
      batches: 2,
      budgetExhausted: true,
    });
    expect(repoCalls).toHaveLength(2);
    // The repo's cutoff is the tick's start, not a moving clock.
    expect(repoCalls.every((c) => c.now.getTime() === NOW.getTime())).toBe(true);
    expect(runAudits(emitTyped)[0]?.payload).toMatchObject({ budget_exhausted: true, completed: true });
  });

  it('honours a custom batch size', async () => {
    const { deps, repoCalls } = makeDeps({ expired: 5, batchSize: 2 });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value.batches).toBe(3);
    expect(repoCalls.map((c) => c.limit)).toEqual([2, 2, 2]);
  });

  it('stamps each batch\'s images on the batch tx and audits them as retention_expired, per owner', async () => {
    const { deps, markDeletedByOwners, emitTyped } = makeDeps({ expired: 3, imagesPerRow: 2 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value.imagesMarked).toBe(6);
    expect(markDeletedByOwners).toHaveBeenCalledTimes(1);
    expect(markDeletedByOwners).toHaveBeenCalledWith('test-tenant', 'broadcast', ['bc-1', 'bc-2', 'bc-3'], NOW, TX);

    const removed = emitTyped.mock.calls
      .map((c) => [c[0], c[1]] as [unknown, { eventType: string; payload: Record<string, unknown> }])
      .filter(([, e]) => e.eventType === 'broadcast_image_removed');
    expect(removed).toHaveLength(6);
    expect(removed.every(([tx]) => tx === TX)).toBe(true);
    expect(removed.map(([, e]) => e.payload['reason'])).toEqual(Array(6).fill('retention_expired'));
    expect(removed.map(([, e]) => e.payload['actor_role'])).toEqual(Array(6).fill('system'));
    // bc-2 carries its owning member; bc-1 / bc-3 were written with none.
    expect(removed.map(([, e]) => e.payload['related_member_id'])).toEqual([null, null, 'm-2', 'm-2', null, null]);
  });

  it('the run row carries counts only — no broadcast id, member id or content', async () => {
    const { deps, emitTyped } = makeDeps({ expired: 2, imagesPerRow: 1 });
    await sweepExpiredBroadcasts(deps);

    const [run] = runAudits(emitTyped);
    expect(run?.actorUserId).toBe('system');
    expect(Object.keys(run?.payload ?? {}).sort()).toEqual(
      ['actor_role', 'batches', 'budget_exhausted', 'completed', 'images_marked', 'swept_count'].sort(),
    );
    expect(JSON.stringify(run?.payload)).not.toMatch(/bc-|m-2/);
  });

  it('a batch that throws: the committed batches are still counted, the run row says completed:false, and the result is an error', async () => {
    const { deps, emitTyped } = makeDeps({ expired: 450, throwOnCall: 2 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'retention_sweep.server_error',
        message: 'Neon: connection terminated',
        sweptCount: 200,
      },
    });
    const audits = runAudits(emitTyped);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({ swept_count: 200, batches: 1, completed: false });
  });

  it('a failed run row is an error even when every batch committed', async () => {
    const { deps } = makeDeps({ expired: 1, auditThrows: true });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'retention_sweep.server_error', message: 'audit down', sweptCount: 1 },
    });
  });

  it('truncates a long error message and names a non-Error throw', async () => {
    const long = makeDeps({ expired: 1 });
    long.deps.broadcastsRepo.deleteExpiredForRetention = async () => {
      throw new Error('x'.repeat(600));
    };
    const r1 = await sweepExpiredBroadcasts(long.deps);
    expect(!r1.ok && r1.error.message).toBe(`${'x'.repeat(500)}…`);

    const odd = makeDeps({ expired: 1 });
    odd.deps.broadcastsRepo.deleteExpiredForRetention = async () => {
      throw 'boom';
    };
    const r2 = await sweepExpiredBroadcasts(odd.deps);
    expect(!r2.ok && r2.error.message).toBe('unknown error');
  });
});
