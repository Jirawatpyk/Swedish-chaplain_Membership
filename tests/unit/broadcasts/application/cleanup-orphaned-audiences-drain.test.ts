/**
 * Spec 140 s2c (DL6) — the orphan drain: `cleanupOrphanedAudiences`' second
 * pass, after the terminal-audience loop (plan.md § Slice 2c, item 5).
 *
 *   - broadcast rows: `deleteBroadcastOnce` — deleted / absent settle as such;
 *     forbidden → ONE `retrieveBroadcastOnce`: canceled / failed → `retained`,
 *     queued / sending / sent → `handed`; anything else is left for the next run;
 *   - audience rows: `deleteAudience` — resolved (a 404 included) → `deleted`,
 *     a throw is left;
 *   - the grace period, skipped when the requester is erased [P H-2];
 *   - at most `ORPHAN_DRAIN_LIMIT` rows, `ORPHAN_DRAIN_CONCURRENCY` at a time,
 *     and no chunk starts after `ORPHAN_DRAIN_STOP_MS`, inside the route's
 *     `maxDuration` (`CLEANUP_MAX_DURATION_MS`);
 *   - log hygiene: `err: errKind(e)` + `tenantId`, never `e.message`.
 * The SQL that keeps `create_unconfirmed` and live-held ids out of the list is
 * the repo's (`broadcast-orphans-repo.test.ts`, `orphan-drain.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import {
  CLEANUP_MAX_DURATION_MS,
  ORPHAN_DRAIN_CONCURRENCY,
  ORPHAN_DRAIN_LIMIT,
  ORPHAN_DRAIN_STOP_MS,
  cleanupOrphanedAudiences,
} from '@/modules/broadcasts/application/use-cases/cleanup-orphaned-audiences';
import { RESEND_CALL_TIMEOUT_MS } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { REPROBE_PAUSE_MS } from '@/modules/broadcasts/application/use-cases/_reprobe-pause';
import type { OrphanedResendIdRef } from '@/modules/broadcasts/application/ports/broadcast-orphans-repo';

const tenant = asTenantContext('test-tenant');
const NOW = new Date('2026-11-03T12:00:00Z');
const GRACE_MS = 60 * 60 * 1000;
const OLD = new Date(NOW.getTime() - 2 * GRACE_MS);
const YOUNG = new Date(NOW.getTime() - 60_000);
const ROUTE = 'src/app/api/cron/broadcasts/cleanup-audiences/route.ts';

type DeleteOnce = 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other';

function orphan(n: number, patch: Partial<OrphanedResendIdRef> = {}): OrphanedResendIdRef {
  return {
    orphanId: `o-${n}`,
    broadcastId: `b-${n}`,
    requestedByMemberId: 'm-live',
    resourceType: 'broadcast',
    resourceId: `rb-${n}`,
    reason: 'attach_lost',
    createdAt: OLD,
    outcome: null,
    attempts: 0,
    heldBySentRow: false,
    ...patch,
  };
}

interface Opts {
  readonly orphans: ReadonlyArray<OrphanedResendIdRef>;
  readonly deleteOnce?: Record<string, DeleteOnce>;
  readonly retrieveOnce?: Record<string, { kind: 'present'; status: string; sentAt?: string | null } | { kind: 'not_found' } | { kind: 'retryable' }>;
  readonly deleteAudienceThrows?: ReadonlySet<string>;
  readonly listThrows?: boolean;
  /** Review round 3 (code-review #2) — only the in-grace-only list throws. */
  readonly inGraceListThrows?: boolean;
  readonly settleThrows?: boolean;
  /** What the settle CAS answers (`false` = a concurrent settler won). Default `true`. */
  readonly settleReturns?: boolean;
  /** `markOrphanAttempted` throws. */
  readonly markThrows?: boolean;
  readonly erased?: Record<string, 'erased' | 'live' | 'throws'>;
  /** The audience pass's candidates (terminal rows still holding an audience). */
  readonly terminal?: ReadonlyArray<{ broadcastId: string; resendAudienceId: string }>;
  readonly terminalListThrows?: boolean;
  /** ms the clock advances on every Resend call. */
  readonly stepMs?: number;
}

function harness(opts: Opts) {
  let nowMs = NOW.getTime();
  const settled: Array<[string, string]> = [];
  const attempted: string[] = [];
  const calls: string[] = [];
  const listLimits: number[] = [];
  const listModes: string[] = [];
  const erasedReads: string[] = [];
  let erasedInFlight = 0;
  let erasedPeak = 0;
  let inFlight = 0;
  let peak = 0;
  const step = async (label: string) => {
    calls.push(label);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    nowMs += opts.stepMs ?? 0;
    inFlight -= 1;
  };
  const deps = {
    tenant,
    clock: { now: () => new Date(nowMs) },
    broadcastsRepo: {
      async listTerminalBroadcastsWithLiveAudience() {
        if (opts.terminalListThrows === true) throw new Error('Neon: password authentication failed for user x');
        return opts.terminal ?? [];
      },
      async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(null);
      },
      async markAudienceDeletedInTx() {},
    },
    orphans: {
      async listDrainableOrphans(limit: number, cutoff: Date, options?: { readonly inGraceOnly?: boolean }) {
        listLimits.push(limit);
        const inGraceOnly = options?.inGraceOnly === true;
        listModes.push(inGraceOnly ? 'in_grace' : 'all');
        if (opts.listThrows === true || (inGraceOnly && opts.inGraceListThrows === true)) {
          throw new Error('Neon: password authentication failed for user x');
        }
        // Review round 3 (code-review #2) — the repo's two lists, each at most
        // `limit`: the fixture order is the past-grace-first order; the
        // in-grace-only list keeps only the rows inside the grace.
        const rows = inGraceOnly ? opts.orphans.filter((o) => o.createdAt.getTime() >= cutoff.getTime()) : opts.orphans;
        return rows.slice(0, limit);
      },
      async settleOrphan(orphanId: string, outcome: string) {
        if (opts.settleThrows === true) throw new Error('57P01');
        settled.push([orphanId, outcome]);
        return opts.settleReturns ?? true;
      },
      async markOrphanAttempted(orphanId: string) {
        if (opts.markThrows === true) throw new Error('57P01');
        attempted.push(orphanId);
        return true;
      },
    },
    membersBridge: {
      async getMemberErasedAt(_t: unknown, memberId: string) {
        erasedReads.push(memberId);
        erasedInFlight += 1;
        erasedPeak = Math.max(erasedPeak, erasedInFlight);
        await Promise.resolve();
        erasedInFlight -= 1;
        const e = opts.erased?.[memberId] ?? 'live';
        if (e === 'throws') throw new Error('members read failed');
        return { erasedAt: e === 'erased' ? new Date('2026-11-01T00:00:00Z') : null };
      },
    },
    broadcastsGateway: {
      async deleteAudience(id: string) {
        await step(`deleteAudience:${id}`);
        if (opts.deleteAudienceThrows?.has(id) === true) throw { kind: 'retryable', subKind: 'timeout', reason: 'aborted' };
      },
      async deleteBroadcastOnce(id: string) {
        await step(`deleteBroadcastOnce:${id}`);
        return { kind: opts.deleteOnce?.[id] ?? 'deleted' };
      },
      async retrieveBroadcastOnce(id: string) {
        await step(`retrieveBroadcastOnce:${id}`);
        // Review round 3 (code-review #6) — `sentAt` is required on present.
        const r = opts.retrieveOnce?.[id] ?? { kind: 'not_found' as const };
        return r.kind === 'present' ? { sentAt: null, ...r } : r;
      },
    },
    // Review round 2 (code-review #4) — the pause before a 404's confirming GET, recorded.
    pauseBeforeReprobe: async (ms: number) => {
      calls.push(`pause:${ms}`);
    },
  };
  const run = () => cleanupOrphanedAudiences(deps as never, { graceMs: GRACE_MS, limit: 50 });
  return { run, settled, attempted, calls, listLimits, listModes, peak: () => peak, erasedReads, erasedPeak: () => erasedPeak };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

describe('spec 140 s2c — the orphan drain in cleanup-audiences (DL6)', () => {
  it.each([
    ['deleted', undefined, 'deleted'],
    ['absent', undefined, 'absent'],
    ['forbidden', { kind: 'present', status: 'cancelled' }, 'retained'],
    ['forbidden', { kind: 'present', status: 'failed' }, 'retained'],
    ['forbidden', { kind: 'present', status: 'queued' }, 'handed'],
    ['forbidden', { kind: 'present', status: 'sent' }, 'handed'],
  ] as const)('a broadcast row whose DELETE answers %s (GET %o) settles %s', async (del, get, outcome) => {
    const h = harness({
      orphans: [orphan(1)],
      deleteOnce: { 'rb-1': del },
      ...(get === undefined ? {} : { retrieveOnce: { 'rb-1': get } }),
    });
    const res = await h.run();
    expect(h.settled).toEqual([['o-1', outcome]]);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 1, settled: 1, undecided: 0 });
  });

  it.each([
    ['retryable', undefined],
    ['other', undefined],
    ['forbidden', { kind: 'present', status: 'draft' }],
    ['forbidden', { kind: 'not_found' }],
    ['forbidden', { kind: 'retryable' }],
  ] as const)('a broadcast row whose DELETE answers %s (GET %o) is left for the next run', async (del, get) => {
    const h = harness({
      orphans: [orphan(1)],
      deleteOnce: { 'rb-1': del },
      ...(get === undefined ? {} : { retrieveOnce: { 'rb-1': get } }),
    });
    const res = await h.run();
    expect(h.settled).toEqual([]);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 1, settled: 0, undecided: 1 });
  });

  it('an audience row: deleteAudience resolves → deleted; a throw is left', async () => {
    const h = harness({
      orphans: [orphan(1, { resourceType: 'audience', resourceId: 'aud-1', reason: 'audience_leaked' }), orphan(2, { resourceType: 'audience', resourceId: 'aud-2', reason: 'audience_leaked' })],
      deleteAudienceThrows: new Set(['aud-2']),
    });
    await h.run();
    expect(h.settled).toEqual([['o-1', 'deleted']]);
    expect(h.calls.filter((c) => c.startsWith('deleteBroadcastOnce'))).toEqual([]);
  });

  it('[P H-2] a row inside the grace is drained only when its requester is erased; a failed read waits', async () => {
    const h = harness({
      orphans: [
        orphan(1, { createdAt: YOUNG, requestedByMemberId: 'm-live' }),
        orphan(2, { createdAt: YOUNG, requestedByMemberId: 'm-erased' }),
        orphan(3, { createdAt: YOUNG, requestedByMemberId: 'm-unreadable' }),
        orphan(4, { createdAt: OLD, requestedByMemberId: 'm-live' }),
      ],
      erased: { 'm-erased': 'erased', 'm-unreadable': 'throws' },
    });
    const res = await h.run();
    expect(h.settled.map(([id]) => id).sort()).toEqual(['o-2', 'o-4']);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 4, settled: 2, waiting: 2 });
  });

  it(`reads at most ORPHAN_DRAIN_LIMIT (${ORPHAN_DRAIN_LIMIT}) rows and settles them ORPHAN_DRAIN_CONCURRENCY (${ORPHAN_DRAIN_CONCURRENCY}) at a time`, async () => {
    const h = harness({ orphans: Array.from({ length: 12 }, (_, i) => orphan(i + 1)) });
    await h.run();
    // Review round 4 (code-review #4) — 12 rows is a short first list: it holds
    // every drainable row, so the in-grace-only list is not read.
    expect(h.listLimits).toEqual([ORPHAN_DRAIN_LIMIT]);
    expect(ORPHAN_DRAIN_LIMIT).toBe(20);
    expect(ORPHAN_DRAIN_CONCURRENCY).toBe(5);
    expect(h.peak()).toBe(ORPHAN_DRAIN_CONCURRENCY);
    expect(h.settled).toHaveLength(12);
  });

  it('no chunk starts after ORPHAN_DRAIN_STOP_MS: the rest wait for the next run', async () => {
    // Each Resend call moves the clock past the stop: the first chunk runs, the second does not.
    const h = harness({ orphans: Array.from({ length: 12 }, (_, i) => orphan(i + 1)), stepMs: ORPHAN_DRAIN_STOP_MS });
    const res = await h.run();
    expect(h.settled).toHaveLength(ORPHAN_DRAIN_CONCURRENCY);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 12, settled: ORPHAN_DRAIN_CONCURRENCY, deferred: 12 - ORPHAN_DRAIN_CONCURRENCY });
  });

  // Review round 4 (code-review #6, reliability nit) — the warn line names
  // the rows the budget cut only (stoppedDeferred); the output's deferred
  // stays the total, the cap overflow included.
  it('stopped_at_budget logs the budget-cut count; the output deferred is the total', async () => {
    const h = harness({
      orphans: [...Array.from({ length: ORPHAN_DRAIN_LIMIT }, (_, i) => orphan(i + 1)), orphan(99, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
      erased: { 'm-erased': 'erased' },
      stepMs: ORPHAN_DRAIN_STOP_MS,
    });
    const res = await h.run();
    const cut = ORPHAN_DRAIN_LIMIT - ORPHAN_DRAIN_CONCURRENCY;
    // One row over the cap, then `cut` rows past the budget.
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: ORPHAN_DRAIN_LIMIT + 1, deferred: 1 + cut });
    const line = warn.mock.calls.find((c) => c[1] === 'broadcasts.orphan_drain.stopped_at_budget');
    expect(line?.[0]).toEqual({ tenantId: tenant.slug, stoppedDeferred: cut });
  });

  it('the stop leaves room for one chunk inside the route maxDuration (CLEANUP_MAX_DURATION_MS)', () => {
    const m = /export const maxDuration = (\d+);\r?\n/.exec(readFileSync(ROUTE, 'utf8'));
    expect(Number(m?.[1]) * 1000).toBe(CLEANUP_MAX_DURATION_MS);
    // One in-flight chunk: a DELETE and a GET at RESEND_CALL_TIMEOUT_MS each, the
    // pause before a 404's confirming GET (review round 2), plus 5 s for the settle.
    expect(ORPHAN_DRAIN_STOP_MS + 2 * RESEND_CALL_TIMEOUT_MS + REPROBE_PAUSE_MS + 5_000).toBeLessThanOrEqual(CLEANUP_MAX_DURATION_MS);
  });

  it('a list that fails is logged (err: errKind, tenantId) and the audience pass still answers ok', async () => {
    const h = harness({ orphans: [], listThrows: true });
    const res = await h.run();
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 0, listFailed: true });
    const line = error.mock.calls.find((c) => c[1] === 'broadcasts.orphan_drain.list_failed');
    expect(line?.[0]).toEqual({ tenantId: tenant.slug, err: 'Error' });
  });

  it('a settle CAS that throws is undecided and logged with ids only', async () => {
    const h = harness({ orphans: [orphan(1)], settleThrows: true });
    const res = await h.run();
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: 0, undecided: 1 });
    const line = warn.mock.calls.find((c) => c[1] === 'broadcasts.orphan_drain.settle_failed');
    expect(line?.[0]).toMatchObject({ tenantId: tenant.slug, orphanId: 'o-1', resourceType: 'broadcast', resourceId: 'rb-1', err: 'Error' });
    expect(line?.[0]).not.toHaveProperty('reason');
  });

  it('log hygiene — the audience pass logs err: errKind(e) + tenantId, never the message; its list failure answers the class', async () => {
    const h = harness({ orphans: [], terminal: [{ broadcastId: 'bc-1', resendAudienceId: 'aud-t1' }], deleteAudienceThrows: new Set(['aud-t1']) });
    await h.run();
    const line = warn.mock.calls.find((c) => c[1] === 'broadcasts.audience_cleanup.delete_failed');
    expect(line?.[0]).toEqual({ tenantId: tenant.slug, broadcastId: 'bc-1', err: 'unknown' });
    const failed = await harness({ orphans: [], terminalListThrows: true }).run();
    expect(failed.ok ? null : failed.error).toMatchObject({ kind: 'cleanup.server_error', message: 'Error' });
  });

  // Spec 140 s2c review round 1 (code-review #2, #4, #6 / reliability L-1).
  it('an undecided answer marks the row attempted, so it sinks below untried rows', async () => {
    const h = harness({ orphans: [orphan(1), orphan(2)], deleteOnce: { 'rb-1': 'retryable' } });
    await h.run();
    expect(h.attempted).toEqual(['o-1']);
    expect(h.settled).toEqual([['o-2', 'deleted']]);
  });

  it('a settle whose CAS lost (a concurrent settler won) is not counted', async () => {
    const h = harness({ orphans: [orphan(1)], settleReturns: false });
    const res = await h.run();
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 1, settled: 0, undecided: 0 });
  });

  it('a failed audience list still drains, and answers cleanup.server_error with the drain counts', async () => {
    const h = harness({ orphans: [orphan(1)], terminalListThrows: true });
    const res = await h.run();
    expect(h.settled).toEqual([['o-1', 'deleted']]);
    expect(res.ok ? null : res.error).toMatchObject({
      kind: 'cleanup.server_error',
      message: 'Error',
      orphans: { listed: 1, settled: 1 },
    });
  });

  it('a failed attempt mark is logged and the run carries on', async () => {
    const h = harness({ orphans: [orphan(1), orphan(2)], deleteOnce: { 'rb-1': 'retryable' }, markThrows: true });
    const res = await h.run();
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: 1, undecided: 1 });
    expect(warn.mock.calls.some((c) => c[1] === 'broadcasts.orphan_drain.attempt_mark_failed')).toBe(true);
  });

  /**
   * Spec 140 s2c review round 2 — code-review #4 (a DELETE 404 is confirmed by
   * a GET after REPROBE_PAUSE_MS) and code-review #2 (`superseded`), through
   * the drain.
   */
  it('[code-review #4] a 404 then a GET draft is not absent; a 404 then a GET 404 settles absent after the pause', async () => {
    const h = harness({
      orphans: [orphan(1), orphan(2)],
      deleteOnce: { 'rb-1': 'absent', 'rb-2': 'absent' },
      retrieveOnce: { 'rb-1': { kind: 'present', status: 'draft' }, 'rb-2': { kind: 'not_found' } },
    });
    const res = await h.run();
    expect(h.settled).toEqual([['o-2', 'absent']]);
    expect(h.attempted).toEqual(['o-1']);
    expect(h.calls.filter((c) => c.endsWith('rb-2') || c.startsWith('pause'))).toEqual([
      'deleteBroadcastOnce:rb-2',
      `pause:${REPROBE_PAUSE_MS}`,
      `pause:${REPROBE_PAUSE_MS}`,
      'retrieveBroadcastOnce:rb-2',
    ]);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: 1, undecided: 1 });
  });

  it('[code-review #2] an orphan whose id a sent row holds is superseded, not handed', async () => {
    const h = harness({
      orphans: [orphan(1, { heldBySentRow: true })],
      deleteOnce: { 'rb-1': 'forbidden' },
      retrieveOnce: { 'rb-1': { kind: 'present', status: 'sent' } },
    });
    await h.run();
    expect(h.settled).toEqual([['o-1', 'superseded']]);
    expect(h.calls).toEqual([]);
  });

  it('[code-review #9] the erased reads run once per distinct requester, together (Promise.all)', async () => {
    const h = harness({
      orphans: [
        orphan(1, { createdAt: YOUNG, requestedByMemberId: 'm-a' }),
        orphan(2, { createdAt: YOUNG, requestedByMemberId: 'm-b' }),
        orphan(3, { createdAt: YOUNG, requestedByMemberId: 'm-a' }),
        orphan(4, { createdAt: OLD, requestedByMemberId: 'm-old' }),
      ],
      erased: { 'm-a': 'erased' },
    });
    await h.run();
    // Only rows inside the grace need the read; one per requester, both in flight at once.
    expect([...h.erasedReads].sort()).toEqual(['m-a', 'm-b']);
    expect(h.erasedPeak()).toBe(2);
    expect(h.settled.map(([id]) => id).sort()).toEqual(['o-1', 'o-3', 'o-4']);
  });

  /**
   * Spec 140 s2c review round 3 (code-review #2) — RoPA 8d residual (1): an
   * erased requester's row is drained within one tick. The past-grace list
   * alone can be filled by 20 rows that keep failing, so the drain reads a
   * second, in-grace-only list and settles the erased requesters' rows first,
   * then the past-grace rows, at most ORPHAN_DRAIN_LIMIT in all.
   */
  it("[code-review #2] 20 failing past-grace rows do not hold back an erased requester's young row", async () => {
    const failing = Array.from({ length: ORPHAN_DRAIN_LIMIT }, (_, i) => orphan(i + 1, { attempts: 5 }));
    const h = harness({
      orphans: [...failing, orphan(99, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
      deleteOnce: Object.fromEntries(failing.map((o) => [o.resourceId, 'retryable' as const])),
      erased: { 'm-erased': 'erased' },
    });
    const res = await h.run();
    expect(h.settled).toEqual([['o-99', 'deleted']]);
    expect(h.listModes).toEqual(['all', 'in_grace']);
    const deletes = h.calls.filter((c) => c.startsWith('deleteBroadcastOnce'));
    expect(deletes[0]).toBe('deleteBroadcastOnce:rb-99');
    expect(deletes).toHaveLength(ORPHAN_DRAIN_LIMIT);
    // One past-grace row is over the cap: left for the next run.
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: ORPHAN_DRAIN_LIMIT + 1, settled: 1, undecided: ORPHAN_DRAIN_LIMIT - 1, waiting: 0, deferred: 1 });
  });

  it('[code-review #2] an in-grace list that fails is logged and the past-grace rows still drain', async () => {
    // Review round 4 (code-review #4) — a full first list, so the second is read.
    const h = harness({ orphans: Array.from({ length: ORPHAN_DRAIN_LIMIT }, (_, i) => orphan(i + 1)), inGraceListThrows: true });
    const res = await h.run();
    expect(h.settled).toHaveLength(ORPHAN_DRAIN_LIMIT);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: ORPHAN_DRAIN_LIMIT, settled: ORPHAN_DRAIN_LIMIT, listFailed: false });
    const line = error.mock.calls.find((c) => c[1] === 'broadcasts.orphan_drain.list_failed');
    expect(line?.[0]).toEqual({ tenantId: tenant.slug, list: 'in_grace', err: 'Error' });
  });

  /**
   * Spec 140 s2c review round 4 (code-review #4) — the in-grace-only list is
   * read only when the first list came back full (ORPHAN_DRAIN_LIMIT rows); a
   * shorter first list already holds every drainable row, young ones included.
   */
  it('[code-review #4] a short first list skips the second', async () => {
    const h = harness({
      orphans: [...Array.from({ length: 4 }, (_, i) => orphan(i + 1)), orphan(9, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
      erased: { 'm-erased': 'erased' },
    });
    const res = await h.run();
    expect(h.listModes).toEqual(['all']);
    expect(h.listLimits).toEqual([ORPHAN_DRAIN_LIMIT]);
    expect(h.settled.map(([id]) => id).sort()).toEqual(['o-1', 'o-2', 'o-3', 'o-4', 'o-9']);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 5, settled: 5, deferred: 0 });
  });

  it('[code-review #4] a full first list reads the in-grace-only list as well', async () => {
    const h = harness({ orphans: Array.from({ length: ORPHAN_DRAIN_LIMIT }, (_, i) => orphan(i + 1)) });
    await h.run();
    expect(h.listModes).toEqual(['all', 'in_grace']);
    expect(h.listLimits).toEqual([ORPHAN_DRAIN_LIMIT, ORPHAN_DRAIN_LIMIT]);
  });
});
