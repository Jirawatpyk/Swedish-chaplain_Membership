/**
 * Spec 140 s2c (DL6) — the orphan drain: `cleanupOrphanedAudiences`' second
 * pass, after the terminal-audience loop (plan.md § Slice 2c, item 5).
 *
 *   - broadcast rows: `deleteBroadcastOnce` — deleted / absent settle as such;
 *     forbidden → ONE `retrieveBroadcastOnce`: canceled / failed → `retained`,
 *     queued / sending / sent → `handed`; anything else is left for the next run;
 *   - audience rows: `deleteAudience` — resolved (a 404 included) → `deleted`,
 *     a throw is left;
 *   - the grace period, skipped when the requester is erased [P H-2]; spec
 *     140 s2d (#736a): the erased requesters' rows are read by requester
 *     (one bridge call, ids in / ids out), first, at most
 *     `ORPHAN_DRAIN_ERASED_SHARE`;
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
  ORPHAN_DRAIN_ERASED_SHARE,
  ORPHAN_DRAIN_LIMIT,
  ORPHAN_DRAIN_STOP_MS,
  ORPHAN_ERASED_REQUESTER_CAP,
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
  /** The first list returns every row, past its limit (a repo that over-returns). */
  readonly firstListOverReturns?: boolean;
  readonly deleteOnce?: Record<string, DeleteOnce>;
  readonly retrieveOnce?: Record<string, { kind: 'present'; status: string; sentAt?: string | null } | { kind: 'not_found' } | { kind: 'retryable' }>;
  readonly deleteAudienceThrows?: ReadonlySet<string>;
  readonly listThrows?: boolean;
  readonly settleThrows?: boolean;
  /** What the settle CAS answers (`false` = a concurrent settler won). Default `true`. */
  readonly settleReturns?: boolean;
  /** `markOrphanAttempted` throws. */
  readonly markThrows?: boolean;
  /** Spec 140 s2d (#736a) — the requesters the bridge answers as erased (ids in, ids out). */
  readonly erased?: Record<string, 'erased' | 'live'>;
  /** Spec 140 s2d (#736a) — which read of the erased-requester path throws. */
  readonly erasedPathThrows?: 'requesters' | 'bridge' | 'rows';
  /** What that read throws (default: a plain Error with a driver-like message). */
  readonly erasedPathError?: unknown;
  /** The audience pass's candidates (terminal rows still holding an audience). */
  readonly terminal?: ReadonlyArray<{ broadcastId: string; resendAudienceId: string; requestedByMemberId: string }>;
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
  const audited: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  /** Spec 140 s2d (#736a) — every read of the erased-requester path, in order. */
  const erasedPath: string[] = [];
  const bridgeCalls: string[][] = [];
  /** Review round 1 (code-review #5) — every read of either path, in the order it STARTED. */
  const readOrder: string[] = [];
  const erasedThrow = () => opts.erasedPathError ?? new Error('Neon: password authentication failed for user x');
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
      // Spec 139 s2 review round 1 (code-review #7) - the dedupe the terminal
      // pass reads before its row; without it the row is a silent lost record.
      async hasAudienceDeletedAuditInTx() {
        return false;
      },
    },
    audit: {
      async emit(_tx: unknown, e: { eventType: string; payload: Record<string, unknown> }) {
        audited.push({ eventType: e.eventType, payload: e.payload });
      },
    },
    orphans: {
      async listDrainableOrphans(limit: number, cutoff: Date) {
        listLimits.push(limit);
        readOrder.push('past');
        if (opts.listThrows === true) throw new Error('Neon: password authentication failed for user x');
        // The repo's order: past-grace rows first, then attempts, then age (a
        // stable sort keeps the fixture order inside a tie).
        const rows = [...opts.orphans].sort(
          (a, b) =>
            Number(a.createdAt.getTime() >= cutoff.getTime()) - Number(b.createdAt.getTime() >= cutoff.getTime()) ||
            a.attempts - b.attempts ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return opts.firstListOverReturns === true ? rows : rows.slice(0, limit);
      },
      // Spec 140 s2d (#736a) — the distinct requesters of the unsettled rows
      // inside the grace, at most `cap`.
      async listInGraceRequesterIds(cutoff: Date, cap: number) {
        erasedPath.push(`requesters:${cap}`);
        readOrder.push('requesters');
        await Promise.resolve();
        if (opts.erasedPathThrows === 'requesters') throw erasedThrow();
        const young = opts.orphans.filter((o) => o.createdAt.getTime() >= cutoff.getTime());
        return [...new Set(young.map((o) => o.requestedByMemberId))].slice(0, cap);
      },
      // Spec 140 s2d (#736a) — those requesters' unsettled rows, any age,
      // attempts then age, at most `limit`.
      async listUnsettledOrphansForRequesters(ids: readonly string[], limit: number) {
        erasedPath.push(`rows:${[...ids].join(',')}:${limit}`);
        readOrder.push('rows');
        if (opts.erasedPathThrows === 'rows') throw erasedThrow();
        return opts.orphans
          .filter((o) => ids.includes(o.requestedByMemberId))
          .sort((a, b) => a.attempts - b.attempts || a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit);
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
      async filterErasedMemberIds(_t: unknown, ids: readonly string[]) {
        bridgeCalls.push([...ids]);
        erasedPath.push('bridge');
        readOrder.push('bridge');
        if (opts.erasedPathThrows === 'bridge') throw opts.erasedPathError ?? new Error('members read failed');
        return ids.filter((id) => opts.erased?.[id] === 'erased');
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
  return { run, settled, attempted, calls, listLimits, peak: () => peak, erasedPath, bridgeCalls, readOrder, audited };
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

  it('[P H-2] a row inside the grace is drained only when its requester is erased', async () => {
    const h = harness({
      orphans: [
        orphan(1, { createdAt: YOUNG, requestedByMemberId: 'm-live' }),
        orphan(2, { createdAt: YOUNG, requestedByMemberId: 'm-erased' }),
        orphan(3, { createdAt: YOUNG, requestedByMemberId: 'm-other' }),
        orphan(4, { createdAt: OLD, requestedByMemberId: 'm-live' }),
      ],
      erased: { 'm-erased': 'erased' },
    });
    const res = await h.run();
    expect(h.settled.map(([id]) => id).sort()).toEqual(['o-2', 'o-4']);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 4, settled: 2, waiting: 2, erasedReadFailed: false });
  });

  it(`reads at most ORPHAN_DRAIN_LIMIT (${ORPHAN_DRAIN_LIMIT}) rows and settles them ORPHAN_DRAIN_CONCURRENCY (${ORPHAN_DRAIN_CONCURRENCY}) at a time`, async () => {
    const h = harness({ orphans: Array.from({ length: 12 }, (_, i) => orphan(i + 1)) });
    await h.run();
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

  // Spec 140 s2d (#736a) — the erased requesters' rows are read before the
  // past-grace list, so they still settle when that list fails.
  it("a failed past-grace list still settles an erased requester's rows", async () => {
    const h = harness({
      orphans: [orphan(1), orphan(2, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
      erased: { 'm-erased': 'erased' },
      listThrows: true,
    });
    const res = await h.run();
    expect(h.settled).toEqual([['o-2', 'deleted']]);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 1, settled: 1, waiting: 0, listFailed: true, erasedReadFailed: false });
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
    const h = harness({
      orphans: [],
      terminal: [{ broadcastId: 'bc-1', resendAudienceId: 'aud-t1', requestedByMemberId: 'm-requester' }],
      deleteAudienceThrows: new Set(['aud-t1']),
    });
    await h.run();
    const line = warn.mock.calls.find((c) => c[1] === 'broadcasts.audience_cleanup.delete_failed');
    expect(line?.[0]).toEqual({ tenantId: tenant.slug, broadcastId: 'bc-1', err: 'unknown' });
    // Spec 139 s2 review round 1 (code-review #7) - the row before the delete
    // is written, not lost (the harness used to lack the audit stubs).
    expect(h.audited).toEqual([
      {
        eventType: 'broadcast_audience_deleted',
        payload: expect.objectContaining({ broadcast_id: 'bc-1', related_member_id: 'm-requester', reason: 'terminal_cleanup' }),
      },
    ]);
    expect(error.mock.calls.filter((c) => c[1] === 'broadcasts.audience_cleanup.audience_audit_lost')).toEqual([]);
    const failed = await harness({ orphans: [], terminalListThrows: true }).run();
    expect(failed.ok ? null : failed.error).toMatchObject({ kind: 'cleanup.server_error', errClass: 'Error' });
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
      errClass: 'Error',
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

  // Spec 140 s2d (#736a) — replaces the per-requester reads (code-review #9):
  // ONE bridge call with the distinct in-grace requesters, then one row read
  // for the erased ones.
  it('the erased read is one bridge call with the distinct in-grace requesters', async () => {
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
    expect(h.bridgeCalls).toEqual([['m-a', 'm-b']]);
    // Review round 2 (code-review #10) — the requester read asks for cap + 1.
    expect(h.erasedPath).toEqual([`requesters:${ORPHAN_ERASED_REQUESTER_CAP + 1}`, 'bridge', `rows:m-a:${ORPHAN_DRAIN_ERASED_SHARE + 1}`]);
    expect(h.settled.map(([id]) => id).sort()).toEqual(['o-1', 'o-3', 'o-4']);
  });

  it('no in-grace requester → no bridge call and no row read', async () => {
    const h = harness({ orphans: [orphan(1)] });
    await h.run();
    expect(h.erasedPath).toEqual([`requesters:${ORPHAN_ERASED_REQUESTER_CAP + 1}`]);
  });

  /**
   * Spec 140 s2c review round 3 (code-review #2) — RoPA 8d residual (1): an
   * erased requester's row is drained within one tick: past-grace rows that
   * keep failing cannot fill the run ahead of it. Spec 140 s2d (#736a) — the
   * erased requesters' rows are read by requester, not from a second list.
   */
  it("[code-review #2] 20 failing past-grace rows do not hold back an erased requester's young row", async () => {
    const failing = Array.from({ length: ORPHAN_DRAIN_LIMIT }, (_, i) => orphan(i + 1, { attempts: 5 }));
    const h = harness({
      orphans: [...failing, orphan(99, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
      deleteOnce: Object.fromEntries(failing.map((o) => [o.resourceId, 'retryable' as const])),
      erased: { 'm-erased': 'erased' },
    });
    const res = await h.run();
    const deletes = h.calls.filter((c) => c.startsWith('deleteBroadcastOnce'));
    expect(deletes[0]).toBe('deleteBroadcastOnce:rb-99');
    expect(deletes).toHaveLength(ORPHAN_DRAIN_LIMIT);
    // One past-grace row is over the cap: left for the next run.
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: ORPHAN_DRAIN_LIMIT + 1, settled: 1, undecided: ORPHAN_DRAIN_LIMIT - 1, waiting: 0, deferred: 1 });
  });

  /**
   * Spec 140 s2d (#736a) — the erased requester, anchored on the orphan
   * (plan.md § Slice 2d — plan review): the drain reads the distinct
   * requesters of the in-grace rows (at most ORPHAN_ERASED_REQUESTER_CAP),
   * asks the members bridge which are erased (ids in, ids out), and reads
   * those requesters' unsettled rows FIRST, at most ORPHAN_DRAIN_ERASED_SHARE;
   * the past-grace list fills the rest. A failed read on that path does not
   * set listFailed: the normal drain runs and erasedReadFailed is set.
   */
  it("25 newer in-grace rows from live members do not hold back an erased requester's row", async () => {
    const newer = Array.from({ length: 25 }, (_, i) => orphan(i + 1, { createdAt: YOUNG }));
    // Older than the 25 and tried once: last in the past-grace list's order.
    const erasedRow = orphan(99, { createdAt: new Date(NOW.getTime() - 30 * 60_000), requestedByMemberId: 'm-erased', attempts: 1 });
    const h = harness({ orphans: [...newer, erasedRow], erased: { 'm-erased': 'erased' } });
    const res = await h.run();
    expect(h.settled.map(([id]) => id)).toContain('o-99');
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: 1, waiting: ORPHAN_DRAIN_LIMIT, erasedReadFailed: false });
  });

  it("an erased requester's 15 undecided rows take at most ORPHAN_DRAIN_ERASED_SHARE slots; past-grace rows fill the rest", async () => {
    const erasedRows = Array.from({ length: 15 }, (_, i) =>
      orphan(100 + i, { createdAt: new Date(YOUNG.getTime() - i * 1000), requestedByMemberId: 'm-erased', attempts: 3 }),
    );
    const pastGrace = Array.from({ length: 15 }, (_, i) => orphan(i + 1));
    const h = harness({
      orphans: [...erasedRows, ...pastGrace],
      erased: { 'm-erased': 'erased' },
      deleteOnce: Object.fromEntries(erasedRows.map((o) => [o.resourceId, 'retryable' as const])),
    });
    const res = await h.run();
    const deletes = h.calls.filter((c) => c.startsWith('deleteBroadcastOnce'));
    const erasedDeletes = deletes.filter((c) => /rb-1\d\d$/.test(c));
    expect(ORPHAN_DRAIN_ERASED_SHARE).toBe(ORPHAN_DRAIN_LIMIT / 2);
    expect(erasedDeletes).toHaveLength(ORPHAN_DRAIN_ERASED_SHARE);
    expect(deletes).toHaveLength(ORPHAN_DRAIN_LIMIT);
    expect(h.settled).toHaveLength(ORPHAN_DRAIN_LIMIT - ORPHAN_DRAIN_ERASED_SHARE);
    // 5 past-grace rows are over the run's cap: left for the next run.
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 25, settled: 10, undecided: 10, waiting: 0, deferred: 5 });
  });

  it.each(['requesters', 'bridge', 'rows'] as const)(
    'the erased path fails at %s → past-grace rows still settle, the erased row waits, erasedReadFailed is set, listFailed is false',
    async (where) => {
      const h = harness({
        orphans: [orphan(1), orphan(2), orphan(9, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
        erased: { 'm-erased': 'erased' },
        erasedPathThrows: where,
      });
      const res = await h.run();
      expect(h.settled.map(([id]) => id).sort()).toEqual(['o-1', 'o-2']);
      expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: 3, settled: 2, waiting: 1, listFailed: false, erasedReadFailed: true });
      const lines = warn.mock.calls.filter((c) => c[1] === 'broadcasts.orphan_drain.erased_read_failed');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.[0]).toEqual({ tenantId: tenant.slug, step: where, err: 'Error', code: undefined });
      expect(error.mock.calls.some((c) => c[1] === 'broadcasts.orphan_drain.list_failed')).toBe(false);
    },
  );

  // Review round 1 (reliability M-1, code-review #4) — which read failed, with its SQLSTATE.
  it("a bridge failure logs step: 'bridge' and the SQLSTATE", async () => {
    const pg = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
    const h = harness({
      orphans: [orphan(9, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
      erased: { 'm-erased': 'erased' },
      erasedPathThrows: 'bridge',
      erasedPathError: new Error('members_bridge_filter_erased:repo.unexpected', { cause: pg }),
    });
    await h.run();
    const line = warn.mock.calls.find((c) => c[1] === 'broadcasts.orphan_drain.erased_read_failed');
    expect(line?.[0]).toEqual({ tenantId: tenant.slug, step: 'bridge', err: 'Error', code: '57P01', pg: {} });
  });

  // Review round 2 (code-review #7) — pgErrorMeta is used: the constraint
  // name an incident needs, never the row's values in `detail`.
  it('a 23505 under the erased read logs its constraint name, never the detail', async () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "x_uniq"'), {
      code: '23505',
      constraint_name: 'x_uniq',
      table_name: 'broadcast_orphans',
      detail: 'Key (email)=(a@x.io) already exists.',
    });
    const h = harness({
      orphans: [orphan(9, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
      erased: { 'm-erased': 'erased' },
      erasedPathThrows: 'rows',
      erasedPathError: new Error('Failed query: select … params: a@x.io', { cause: pg }),
    });
    await h.run();
    const line = warn.mock.calls.find((c) => c[1] === 'broadcasts.orphan_drain.erased_read_failed');
    expect(line?.[0]).toEqual({
      tenantId: tenant.slug,
      step: 'rows',
      err: 'Error',
      code: '23505',
      pg: { constraint: 'x_uniq', table: 'broadcast_orphans' },
    });
    expect(JSON.stringify(line?.[0])).not.toMatch(/a@x\.io|Key \(/);
  });

  // Review round 1 (code-review #5) — the erased reads and the past-grace list run side by side.
  it('the past-grace list starts before the erased chain reaches the members bridge', async () => {
    const h = harness({
      orphans: [orphan(1), orphan(9, { createdAt: YOUNG, requestedByMemberId: 'm-erased' })],
      erased: { 'm-erased': 'erased' },
    });
    await h.run();
    expect(h.readOrder.indexOf('past')).toBeGreaterThanOrEqual(0);
    expect(h.readOrder.indexOf('past')).toBeLessThan(h.readOrder.indexOf('bridge'));
  });

  // Review round 1 (the maintainer's /verify finding, pdpa L-d, reliability L-2) — a full share shows.
  it('16 erased rows → erasedShareFull true, 10 settled', async () => {
    const young = Array.from({ length: 16 }, (_, i) =>
      orphan(i + 1, { createdAt: new Date(YOUNG.getTime() - i * 1000), requestedByMemberId: 'm-erased' }),
    );
    const h = harness({ orphans: young, erased: { 'm-erased': 'erased' } });
    const res = await h.run();
    expect(ORPHAN_DRAIN_ERASED_SHARE).toBe(10);
    expect(h.settled).toHaveLength(10);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: 10, erasedShareFull: true, erasedReadFailed: false });
  });

  it('a share that holds every erased row → erasedShareFull false', async () => {
    const young = Array.from({ length: ORPHAN_DRAIN_ERASED_SHARE }, (_, i) =>
      orphan(i + 1, { createdAt: new Date(YOUNG.getTime() - i * 1000), requestedByMemberId: 'm-erased' }),
    );
    const h = harness({ orphans: young, erased: { 'm-erased': 'erased' } });
    const res = await h.run();
    expect(h.settled).toHaveLength(ORPHAN_DRAIN_ERASED_SHARE);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: ORPHAN_DRAIN_ERASED_SHARE, erasedShareFull: false });
  });

  it('[pdpa H-1] requester erased 3 h before the orphan was written, the row in grace → settled this tick', async () => {
    // The bridge answers ids only: there is no erased_at window to fall out of.
    const h = harness({
      orphans: [orphan(1, { createdAt: YOUNG, requestedByMemberId: 'm-erased-3h-before' })],
      erased: { 'm-erased-3h-before': 'erased' },
    });
    const res = await h.run();
    expect(h.settled).toEqual([['o-1', 'deleted']]);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: 1, waiting: 0 });
  });

  // Review round 2 (code-review #10) — the capped line means truncated: the
  // read asks for cap + 1, and only a list longer than the cap is capped.
  it('more than ORPHAN_ERASED_REQUESTER_CAP in-grace requesters → logged (erased_requesters_capped), the bridge gets the cap, the run carries on', async () => {
    const many = Array.from({ length: ORPHAN_ERASED_REQUESTER_CAP + 1 }, (_, i) => orphan(i + 1, { createdAt: YOUNG, requestedByMemberId: `m-${i}` }));
    const h = harness({ orphans: [...many, orphan(999)], erased: { 'm-3': 'erased' } });
    const res = await h.run();
    expect(h.bridgeCalls[0]).toHaveLength(ORPHAN_ERASED_REQUESTER_CAP);
    expect(h.settled.map(([id]) => id).sort()).toEqual(['o-4', 'o-999']);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: 2, erasedReadFailed: false });
    const line = warn.mock.calls.find((c) => c[1] === 'broadcasts.orphan_drain.erased_requesters_capped');
    expect(line?.[0]).toEqual({ tenantId: tenant.slug, cap: ORPHAN_ERASED_REQUESTER_CAP });
  });

  it('exactly ORPHAN_ERASED_REQUESTER_CAP in-grace requesters → no capped line, all of them asked', async () => {
    const exact = Array.from({ length: ORPHAN_ERASED_REQUESTER_CAP }, (_, i) => orphan(i + 1, { createdAt: YOUNG, requestedByMemberId: `m-${i}` }));
    const h = harness({ orphans: exact });
    await h.run();
    expect(h.bridgeCalls[0]).toHaveLength(ORPHAN_ERASED_REQUESTER_CAP);
    expect(warn.mock.calls.some((c) => c[1] === 'broadcasts.orphan_drain.erased_requesters_capped')).toBe(false);
  });

  it('fewer in-grace requesters than the cap → no capped line', async () => {
    const h = harness({ orphans: [orphan(1, { createdAt: YOUNG })] });
    await h.run();
    expect(warn.mock.calls.some((c) => c[1] === 'broadcasts.orphan_drain.erased_requesters_capped')).toBe(false);
  });

  it("an erased requester's in-grace rows the share left out are deferred, not waiting", async () => {
    const young = Array.from({ length: ORPHAN_DRAIN_ERASED_SHARE + 2 }, (_, i) =>
      orphan(i + 1, { createdAt: new Date(YOUNG.getTime() - i * 1000), requestedByMemberId: 'm-erased' }),
    );
    const h = harness({ orphans: young, erased: { 'm-erased': 'erased' } });
    const res = await h.run();
    expect(h.settled).toHaveLength(ORPHAN_DRAIN_ERASED_SHARE);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ settled: ORPHAN_DRAIN_ERASED_SHARE, waiting: 0, deferred: 2 });
  });

  // Review round 4 follow-up (code-review #7) — a past-grace list longer than
  // its limit still caps the run at ORPHAN_DRAIN_LIMIT.
  it('[code-review #7] a past-grace list longer than the limit still settles at most ORPHAN_DRAIN_LIMIT', async () => {
    const h = harness({ orphans: Array.from({ length: ORPHAN_DRAIN_LIMIT + 1 }, (_, i) => orphan(i + 1)), firstListOverReturns: true });
    const res = await h.run();
    expect(h.settled).toHaveLength(ORPHAN_DRAIN_LIMIT);
    expect(res.ok ? res.value.orphans : null).toMatchObject({ listed: ORPHAN_DRAIN_LIMIT + 1, deferred: 1 });
  });
});
