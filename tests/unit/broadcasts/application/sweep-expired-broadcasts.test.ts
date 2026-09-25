/**
 * F7 retention sweep (migration 0310) — `sweepExpiredBroadcasts`.
 *
 * Pins the loop (bounded batches, a wall-clock budget), the three phases of a
 * batch — read the candidates without a lock, delete their Resend copies
 * OUTSIDE any transaction, then delete only the confirmed rows in one
 * transaction that re-checks eligibility — the image stamp that co-commits
 * with each delete, and the ONE counts-only `broadcast_retention_swept` row
 * per run.
 *
 * What the repository selects (terminal, past the anchor + retention_years,
 * no live Resend audience) and that the children leave by cascade is proven
 * against live Postgres in
 * `tests/integration/broadcasts/broadcast-retention-sweep.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ warn: [] as unknown[][], info: [] as unknown[][], error: [] as unknown[][] }));
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => logged.warn.push(args),
    info: (...args: unknown[]) => logged.info.push(args),
    error: (...args: unknown[]) => logged.error.push(args),
    debug: () => undefined,
  },
}));

import {
  sweepExpiredBroadcasts,
  type SweepExpiredBroadcastsDeps,
} from '@/modules/broadcasts/application/use-cases/sweep-expired-broadcasts';
import type { BroadcastImageRecord } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import type { RetentionCandidate, RetentionCursor } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { asTenantContext } from '@/modules/tenants';

const tenant = asTenantContext('test-tenant');
const NOW = new Date('2031-06-15T20:50:00.000Z');
const TX = Symbol('batch-tx');

/** What the fake gateway does for one Resend id. */
type ProviderBehaviour = 'deleted' | 'transient' | 'refused' | 'not_a_gateway_error';

interface FakeRow {
  readonly broadcastId: string;
  readonly requestedByMemberId: string | null;
  readonly anchor: Date;
  readonly resendBroadcastIds: readonly string[];
}

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

/** `n` expired rows, oldest first, one day apart, no Resend copies. */
function plainRows(n: number): FakeRow[] {
  return Array.from({ length: n }, (_v, i) => ({
    broadcastId: `bc-${i + 1}`,
    requestedByMemberId: (i + 1) % 2 === 0 ? `m-${i + 1}` : null,
    anchor: new Date(Date.UTC(2026, 0, 1 + i)),
    resendBroadcastIds: [],
  }));
}

const keyOf = (r: FakeRow): string => `${r.anchor.toISOString()}|${r.broadcastId}`;

function makeDeps(opts: {
  rows?: FakeRow[];
  provider?: Record<string, ProviderBehaviour>;
  /** Throw on this (1-based) delete call. */
  deleteThrowsOnCall?: number;
  imagesPerRow?: number;
  /** Advance the clock by this much on every read after the first. */
  tickMs?: number;
  auditThrows?: boolean;
  timeBudgetMs?: number;
  batchSize?: number;
}) {
  // The fake table: rows leave it only through `deleteExpiredForRetention`.
  const table = new Map<string, FakeRow>((opts.rows ?? []).map((r) => [r.broadcastId, r]));
  const events: string[] = [];
  const listCalls: Array<{ tenantId: string; now: Date; limit: number; after: RetentionCursor | null }> = [];
  const deleteCalls: Array<{ tenantId: string; now: Date; ids: readonly string[]; tx: unknown }> = [];
  const gatewayCalls: string[] = [];
  const txOpened: number[] = [];
  let deleteCallCount = 0;
  let clockReads = 0;

  const listExpiredForRetention = vi.fn(
    async (tenantId: string, now: Date, limit: number, after: RetentionCursor | null): Promise<readonly RetentionCandidate[]> => {
      listCalls.push({ tenantId, now, limit, after });
      events.push('list');
      const afterKey = after === null ? null : `${after.anchorKey}|${after.broadcastId}`;
      return [...table.values()]
        .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
        .filter((r) => afterKey === null || keyOf(r) > afterKey)
        .slice(0, limit)
        .map((r) => ({
          broadcastId: r.broadcastId,
          anchorKey: r.anchor.toISOString(),
          resendBroadcastIds: r.resendBroadcastIds,
        }));
    },
  );

  const deleteExpiredForRetention = vi.fn(async (tenantId: string, now: Date, ids: readonly string[], tx: unknown) => {
    deleteCallCount += 1;
    deleteCalls.push({ tenantId, now, ids: [...ids], tx });
    events.push(`delete:${ids.join(',')}`);
    if (opts.deleteThrowsOnCall === deleteCallCount) {
      throw new Error('Failed query: DELETE … params: 7f3c1a52-0000-4000-8000-000000000001', {
        cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
      });
    }
    const swept = ids.flatMap((id) => {
      const r = table.get(id);
      if (!r) return [];
      table.delete(id);
      return [{ broadcastId: r.broadcastId, requestedByMemberId: r.requestedByMemberId, anchor: r.anchor }];
    });
    return { swept };
  });

  const deleteBroadcast = vi.fn(async (resendId: string) => {
    gatewayCalls.push(resendId);
    events.push(`resend:${resendId}`);
    switch (opts.provider?.[resendId] ?? 'deleted') {
      case 'deleted':
        return;
      case 'transient':
        throw Object.assign(new Error('Resend 503 for re_secret'), { kind: 'retryable', subKind: 'server_5xx', reason: 'down' });
      case 'refused':
        throw Object.assign(new Error('Resend 422 for re_secret'), {
          kind: 'permanent',
          code: 'validation_error',
          reason: 'You can only delete broadcasts that have not been sent',
        });
      case 'not_a_gateway_error':
        throw new TypeError('cannot read properties of undefined');
    }
  });

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
        events.push('tx');
        return fn(TX);
      },
      listExpiredForRetention,
      deleteExpiredForRetention,
    },
    broadcastsGateway: { deleteBroadcast },
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
  return { deps, table, events, listCalls, deleteCalls, gatewayCalls, txOpened, markDeletedByOwners, emitTyped };
}

function runAudits(emitTyped: ReturnType<typeof vi.fn>) {
  return emitTyped.mock.calls
    .map((c) => c[1] as { eventType: string; payload: Record<string, unknown>; actorUserId: string })
    .filter((e) => e.eventType === 'broadcast_retention_swept');
}

const ZERO_OUTPUT = {
  sweptCount: 0,
  imagesMarked: 0,
  batches: 1,
  budgetExhausted: false,
  providerCopyKeptTransient: 0,
  providerCopyRetainedAtProcessor: 0,
  oldestAnchor: null,
  newestAnchor: null,
};

beforeEach(() => {
  logged.warn.length = 0;
  logged.info.length = 0;
  logged.error.length = 0;
});

describe('sweepExpiredBroadcasts — the batch loop', () => {
  it('zero rows: one read, no delete transaction, no Resend call, and still ONE run row saying 0', async () => {
    const { deps, listCalls, deleteCalls, gatewayCalls, txOpened, markDeletedByOwners, emitTyped } = makeDeps({});
    const result = await sweepExpiredBroadcasts(deps);

    expect(result).toEqual({ ok: true, value: ZERO_OUTPUT });
    expect(listCalls).toEqual([{ tenantId: 'test-tenant', now: NOW, limit: 200, after: null }]);
    expect(deleteCalls).toHaveLength(0);
    expect(gatewayCalls).toHaveLength(0);
    expect(markDeletedByOwners).not.toHaveBeenCalled();
    expect(txOpened).toHaveLength(1); // the run row only
    const audits = runAudits(emitTyped);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toEqual({
      swept_count: 0,
      images_marked: 0,
      batches: 1,
      budget_exhausted: false,
      completed: true,
      provider_copy_kept_transient: 0,
      provider_copy_retained_at_processor: 0,
      oldest_anchor: null,
      newest_anchor: null,
      actor_role: 'system',
    });
  });

  it('batches of 200 until a short batch, one delete transaction per batch (+1 for the run row), each read after the last', async () => {
    const { deps, listCalls, deleteCalls, txOpened, emitTyped } = makeDeps({ rows: plainRows(450) });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toMatchObject({ sweptCount: 450, batches: 3, budgetExhausted: false });
    expect(listCalls.map((c) => c.limit)).toEqual([200, 200, 200]);
    expect(listCalls[0]?.after).toBeNull();
    expect(listCalls[1]?.after).toEqual({ anchorKey: new Date(Date.UTC(2026, 0, 200)).toISOString(), broadcastId: 'bc-200' });
    expect(deleteCalls.map((c) => c.ids.length)).toEqual([200, 200, 50]);
    expect(deleteCalls.every((c) => c.tx === TX && c.now.getTime() === NOW.getTime())).toBe(true);
    expect(txOpened).toHaveLength(4);
    expect(runAudits(emitTyped)[0]?.payload).toMatchObject({ swept_count: 450, batches: 3 });
  });

  it('an exact multiple of the batch size costs one more (empty) read, never an extra delete', async () => {
    const { deps, listCalls, deleteCalls } = makeDeps({ rows: plainRows(400) });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value.sweptCount).toBe(400);
    expect(listCalls).toHaveLength(3);
    expect(deleteCalls).toHaveLength(2);
  });

  it('stops on the time budget between batches and says so', async () => {
    // Every clock read is 30 s later; the budget is 45 s.
    const { deps, listCalls, emitTyped } = makeDeps({ rows: plainRows(1000), tickMs: 30_000, timeBudgetMs: 45_000 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toMatchObject({ sweptCount: 400, batches: 2, budgetExhausted: true });
    expect(listCalls).toHaveLength(2);
    // The repo's cutoff is the tick's start, not a moving clock.
    expect(listCalls.every((c) => c.now.getTime() === NOW.getTime())).toBe(true);
    expect(runAudits(emitTyped)[0]?.payload).toMatchObject({ budget_exhausted: true, completed: true });
  });

  it('honours a custom batch size', async () => {
    const { deps, listCalls } = makeDeps({ rows: plainRows(5), batchSize: 2 });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value.batches).toBe(3);
    expect(listCalls.map((c) => c.limit)).toEqual([2, 2, 2]);
  });

  it('stamps each batch\'s images on the batch tx and audits them as retention_expired, per owner', async () => {
    const { deps, markDeletedByOwners, emitTyped } = makeDeps({ rows: plainRows(3), imagesPerRow: 2 });
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

  it('the run row carries counts and the swept anchor range only — no broadcast id, member id, Resend id or content', async () => {
    const rows = plainRows(2).map((r) => ({ ...r, resendBroadcastIds: [`re_${r.broadcastId}`] }));
    const { deps, emitTyped } = makeDeps({ rows, imagesPerRow: 1 });
    await sweepExpiredBroadcasts(deps);

    const [run] = runAudits(emitTyped);
    expect(run?.actorUserId).toBe('system');
    expect(Object.keys(run?.payload ?? {}).sort()).toEqual(
      [
        'actor_role',
        'batches',
        'budget_exhausted',
        'completed',
        'images_marked',
        'newest_anchor',
        'oldest_anchor',
        'provider_copy_retained_at_processor',
        'provider_copy_kept_transient',
        'swept_count',
      ].sort(),
    );
    expect(JSON.stringify(run?.payload)).not.toMatch(/bc-|m-2|re_/);
  });

  it('the anchor range spans every batch: the oldest and newest anchor of the rows actually deleted', async () => {
    const { deps, emitTyped } = makeDeps({ rows: plainRows(5), batchSize: 2 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value.oldestAnchor).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(result.ok && result.value.newestAnchor).toEqual(new Date(Date.UTC(2026, 0, 5)));
    expect(runAudits(emitTyped)[0]?.payload).toMatchObject({
      oldest_anchor: '2026-01-01T00:00:00.000Z',
      newest_anchor: '2026-01-05T00:00:00.000Z',
    });
  });
});

describe('sweepExpiredBroadcasts — the Resend copy (M1)', () => {
  /** Three rows: one Resend copy, two copies (a per-batch one + its own), none. */
  const RESEND_ROWS: FakeRow[] = [
    { broadcastId: 'bc-a', requestedByMemberId: null, anchor: new Date('2026-01-01T00:00:00Z'), resendBroadcastIds: ['re_a'] },
    {
      broadcastId: 'bc-b',
      requestedByMemberId: 'm-b',
      anchor: new Date('2026-01-02T00:00:00Z'),
      // A per-batch copy (broadcast_batch_manifests.provider_broadcast_id) plus the row's own.
      resendBroadcastIds: ['re_b_batch0', 're_b'],
    },
    { broadcastId: 'bc-c', requestedByMemberId: null, anchor: new Date('2026-01-03T00:00:00Z'), resendBroadcastIds: [] },
  ];
  const withResend = (provider: Record<string, ProviderBehaviour>) => makeDeps({ rows: RESEND_ROWS, provider });

  it('deletes every Resend copy BEFORE the row, outside the delete transaction, and deletes the row once they are gone', async () => {
    const { deps, events, gatewayCalls, deleteCalls, table } = withResend({});
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toMatchObject({ sweptCount: 3, providerCopyKeptTransient: 0, providerCopyRetainedAtProcessor: 0 });
    expect([...gatewayCalls].sort()).toEqual(['re_a', 're_b', 're_b_batch0']);
    expect(deleteCalls[0]?.ids).toEqual(['bc-a', 'bc-b', 'bc-c']);
    // Every Resend call happened before the batch transaction opened.
    const firstTx = events.indexOf('tx');
    expect(events.slice(0, firstTx).filter((e) => e.startsWith('resend:'))).toHaveLength(3);
    expect(events.slice(firstTx).some((e) => e.startsWith('resend:'))).toBe(false);
    expect(table.size).toBe(0);
  });

  it('an already-gone copy (the gateway resolves a 404 / 410) lets the row go', async () => {
    // The adapter turns 404 / 410 into a plain resolve (resend-delete-broadcast.test.ts);
    // to this use case that is indistinguishable from a delete, which is the point.
    const { deps, deleteCalls } = withResend({ re_a: 'deleted' });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value.sweptCount).toBe(3);
    expect(deleteCalls[0]?.ids).toContain('bc-a');
  });

  it('a TRANSIENT failure keeps the row (never drops the key) and counts it; the rest of the batch still goes', async () => {
    const { deps, deleteCalls, table, emitTyped } = withResend({ re_a: 'transient' });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toMatchObject({ sweptCount: 2, providerCopyKeptTransient: 1, providerCopyRetainedAtProcessor: 0 });
    expect(deleteCalls[0]?.ids).toEqual(['bc-b', 'bc-c']);
    expect([...table.keys()]).toEqual(['bc-a']);
    expect(runAudits(emitTyped)[0]?.payload).toMatchObject({ provider_copy_kept_transient: 1, completed: true });
  });

  it('a PERMANENT refusal (Resend: a sent broadcast cannot be deleted) DELETES our row anyway and counts the copy as retained at the processor', async () => {
    const { deps, deleteCalls, table, emitTyped } = withResend({ re_a: 'refused' });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toMatchObject({
      sweptCount: 3,
      providerCopyKeptTransient: 0,
      providerCopyRetainedAtProcessor: 1,
    });
    expect(deleteCalls[0]?.ids).toEqual(['bc-a', 'bc-b', 'bc-c']);
    expect(table.has('bc-a')).toBe(false);
    expect(runAudits(emitTyped)[0]?.payload).toMatchObject({
      provider_copy_retained_at_processor: 1,
      provider_copy_kept_transient: 0,
    });
  });

  it('a refused batch copy does not stop the row\'s own copy from being deleted; the row goes', async () => {
    const { deps, gatewayCalls, table } = withResend({ re_b_batch0: 'refused' });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value).toMatchObject({ sweptCount: 3, providerCopyRetainedAtProcessor: 1 });
    expect(gatewayCalls).toEqual(expect.arrayContaining(['re_b_batch0', 're_b']));
    expect(table.has('bc-b')).toBe(false);
  });

  it('a throw that is NOT a classified gateway error is no refusal: the row and its key are kept for the next run', async () => {
    const { deps, table } = withResend({ re_a: 'not_a_gateway_error' });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value).toMatchObject({
      sweptCount: 2,
      providerCopyKeptTransient: 1,
      providerCopyRetainedAtProcessor: 0,
    });
    expect(table.has('bc-a')).toBe(true);
  });

  it('ONE surviving copy is enough to keep the row: the batch copy went, the row\'s own did not', async () => {
    const { deps, gatewayCalls, table } = withResend({ re_b: 'transient' });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value).toMatchObject({ sweptCount: 2, providerCopyKeptTransient: 1 });
    expect(gatewayCalls).toContain('re_b_batch0');
    expect(table.has('bc-b')).toBe(true);
  });

  it('a kept row is not read again in the same run (the next read starts after it)', async () => {
    const rows = plainRows(3).map((r) => ({ ...r, resendBroadcastIds: [`re_${r.broadcastId}`] }));
    const { deps, listCalls, gatewayCalls } = makeDeps({
      rows,
      batchSize: 1,
      provider: { 're_bc-1': 'transient', 're_bc-2': 'transient' },
    });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toMatchObject({ sweptCount: 1, providerCopyKeptTransient: 2, providerCopyRetainedAtProcessor: 0 });
    expect(gatewayCalls).toEqual(['re_bc-1', 're_bc-2', 're_bc-3']);
    expect(listCalls.map((c) => c.after?.broadcastId ?? null)).toEqual([null, 'bc-1', 'bc-2', 'bc-3']);
  });

  it('a batch whose every row was kept opens no delete transaction', async () => {
    const { deps, deleteCalls, txOpened } = makeDeps({
      rows: [{ broadcastId: 'bc-a', requestedByMemberId: null, anchor: NOW, resendBroadcastIds: ['re_a'] }],
      provider: { re_a: 'transient' },
    });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok && result.value.sweptCount).toBe(0);
    expect(deleteCalls).toHaveLength(0);
    expect(txOpened).toHaveLength(1); // the run row
  });

  it('logs a copy left at Resend with the error class and provider code only — never a broadcast id, Resend id or the provider text', async () => {
    const { deps } = makeDeps({
      rows: [{ broadcastId: 'bc-secret', requestedByMemberId: 'm-secret', anchor: NOW, resendBroadcastIds: ['re_secret'] }],
      provider: { re_secret: 'refused' },
    });
    await sweepExpiredBroadcasts(deps);

    expect(logged.warn).toHaveLength(1);
    const [fields, msg] = logged.warn[0] as [Record<string, unknown>, string];
    expect(msg).toBe('broadcasts.retention_sweep.provider_copy_kept');
    expect(fields).toEqual({
      tenantId: 'test-tenant',
      outcome: 'retained_at_processor',
      errorKind: 'permanent',
      code: 'validation_error',
    });
    const everything = JSON.stringify([logged.warn, logged.info, logged.error]);
    expect(everything).not.toMatch(/secret|only delete/);
  });

  it('stops calling Resend when the time budget runs out mid-batch; the confirmed rows are still deleted', async () => {
    // 12 rows, all with a copy, chunks of 5: the clock passes the 45 s budget
    // after the first chunk, so rows 6..12 are not attempted this run.
    const rows = plainRows(12).map((r) => ({ ...r, resendBroadcastIds: [`re_${r.broadcastId}`] }));
    const { deps, gatewayCalls, deleteCalls, table } = makeDeps({ rows, tickMs: 30_000, timeBudgetMs: 45_000 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok && result.value).toMatchObject({
      sweptCount: 5,
      batches: 1,
      budgetExhausted: true,
      providerCopyKeptTransient: 0,
      providerCopyRetainedAtProcessor: 0,
    });
    expect(gatewayCalls).toHaveLength(5);
    expect(deleteCalls[0]?.ids).toEqual(['bc-1', 'bc-2', 'bc-3', 'bc-4', 'bc-5']);
    expect(table.size).toBe(7);
  });
});

describe('sweepExpiredBroadcasts — failures', () => {
  it('a batch that throws (e.g. 55P03 lock timeout): committed batches still counted, run row completed:false, error carries the cause and no message', async () => {
    const { deps, emitTyped } = makeDeps({ rows: plainRows(450), deleteThrowsOnCall: 2 });
    const result = await sweepExpiredBroadcasts(deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('retention_sweep.server_error');
    expect(result.error.sweptCount).toBe(200);
    expect(result.error.cause).toBeInstanceOf(Error);
    expect((result.error.cause as { cause?: { code?: string } }).cause?.code).toBe('55P03');
    expect(result.error).not.toHaveProperty('message');

    const audits = runAudits(emitTyped);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({ swept_count: 200, batches: 2, completed: false });
  });

  it('a failed run row is an error even when every batch committed, and carries that cause', async () => {
    const { deps } = makeDeps({ rows: plainRows(1), auditThrows: true });
    const result = await sweepExpiredBroadcasts(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sweptCount).toBe(1);
    expect((result.error.cause as Error).message).toBe('audit down');
  });

  it('a read that throws is a failure of the run, with the run row still written', async () => {
    const { deps, emitTyped } = makeDeps({ rows: plainRows(1) });
    deps.broadcastsRepo.listExpiredForRetention = async () => {
      throw 'boom';
    };
    const result = await sweepExpiredBroadcasts(deps);
    expect(result).toEqual({ ok: false, error: { kind: 'retention_sweep.server_error', sweptCount: 0, cause: 'boom' } });
    expect(runAudits(emitTyped)[0]?.payload).toMatchObject({ completed: false, batches: 0 });
  });
});
