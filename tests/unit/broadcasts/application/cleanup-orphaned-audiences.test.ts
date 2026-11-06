/**
 * PR-2 Task 3 — Unit tests for `cleanup-orphaned-audiences.ts` Application
 * use-case (defect #5: Resend audiences accumulate forever after a broadcast
 * reaches terminal status).
 *
 * Covers:
 *   (a) 0 candidates → ok({ processed:0, deleted:0, failed:0 }) with no
 *       gateway or mark calls.
 *   (b) 2 candidates: gateway resolves for #1, throws GatewayThrowable for #2
 *       → ok({ processed:2, deleted:1, failed:1 }), mark called for #1 only,
 *       throw for #2 does NOT propagate (best-effort per brief).
 *   (c) graceCutoff is derived from `clock.now() - graceMs` (deterministic).
 *   (d) repo list throws → cleanup.server_error (outer-catch).
 *
 * Project memory: `mock-only-tests-miss-throw-paths` — the per-item try/catch
 * + this throw-path test are MANDATORY (brief §Step 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupOrphanedAudiences } from '@/modules/broadcasts/application/use-cases/cleanup-orphaned-audiences';
import { asTenantContext } from '@/modules/tenants';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { GatewayThrowable } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { AuditPortInvariantError } from '@/modules/broadcasts/application/ports/audit-port';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date('2026-06-21T12:00:00Z');
const GRACE_MS = 60 * 60 * 1000; // 1 hour
const EXPECTED_CUTOFF = new Date(FROZEN_NOW.getTime() - GRACE_MS);

const tenant = asTenantContext('test-tenant');
const clock = { now: (): Date => FROZEN_NOW };

/** Spec 140 s2c — the orphan drain's deps with nothing to drain; its own suite is cleanup-orphaned-audiences-drain.test.ts. */
const NO_DRAIN_DEPS = {
  orphans: {
    async listDrainableOrphans() { return []; },
    async listInGraceRequesterIds() { return []; },
    async listUnsettledOrphansForRequesters() { return []; },
    async settleOrphan() { return false; },
    async markOrphanAttempted() { return false; },
  },
  // Spec 140 s2d (#736a) — ids in, ids out.
  membersBridge: { async filterErasedMemberIds() { return []; } },
  // Spec 139 s2 — the deleted row before each delete; its cells are at the end.
  audit: { async emit() {} },
};
const NO_ORPHAN_RUN = { listed: 0, settled: 0, undecided: 0, waiting: 0, deferred: 0, listFailed: false, erasedReadFailed: false, erasedShareFull: false };

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/**
 * Minimal BroadcastsRepo stub. Only the three methods used by
 * cleanupOrphanedAudiences are instrumented; everything else throws so
 * accidental calls are caught at test time.
 */
function makeRepo(opts: {
  candidates: ReadonlyArray<{ broadcastId: string; resendAudienceId: string }>;
  shouldThrowOnList?: boolean;
}): {
  port: BroadcastsRepo;
  listCalls: Array<{ tenantId: string; graceCutoff: Date; limit: number }>;
  markCalls: Array<string>; // broadcastIds passed to markAudienceDeletedInTx
} {
  const listCalls: Array<{ tenantId: string; graceCutoff: Date; limit: number }> = [];
  const markCalls: Array<string> = [];

  const port: BroadcastsRepo = {
    async withTx(fn) {
      // Simulate a lightweight tx object (unit — no real DB)
      return fn({});
    },
    async insertDraft() { throw new Error('not used in cleanup-orphaned-audiences fixture'); },
    async updateDraft() { throw new Error('not used in cleanup-orphaned-audiences fixture'); },
    async updateDraftFromTemplate() { throw new Error('not used in cleanup-orphaned-audiences fixture'); },
    async findById() { return null; },
    async findByIdInTx() { return null; },
    async lockForUpdate() { return null; },
    async applyTransition() { throw new Error('not used in cleanup-orphaned-audiences fixture'); },
    async attachResendIds() {},
    async attachBroadcastId() {},
    async attachAudienceId() {},
    // Phase 9b (T147) — unused here; present so the stub still satisfies
    // BroadcastsRepo.
    // T086 — unused here; present so the stub still satisfies BroadcastsRepo.
    async attachAudienceImport() {},
    async markAudienceImportCompleted() {},
    async markDispatchRetryStarted() { return null; },
    async releaseAudienceImport() {
      return 'cas_lost' as const;
    },
    async releaseResendAudience() {
      return 'cas_lost' as const;
    },
    async readAlreadySentEvidenceInTx() {
      return { broadcastRecorded: false, memberBroadcastCount: 0 };
    },
    async hasUnverifiableCountAuditInTx() {
      return false;
    },
    async hasAudienceDeletedAuditInTx() {
      return false;
    },
    async findAudienceDisclosureInTx() {
      return null;
    },
    async clearDispatchRetryClock() {},
    async listByTenantStatus() { return { rows: [], nextCursor: null }; },
    async countForMemberQuota() { return { submittedOrApproved: 0, sent: 0 }; },
    async findByResendBroadcastIdBypassRls() { return null; },
    async listForMemberPaginated() { return { rows: [], total: 0, totalPages: 0, page: 1 }; },
    async findOwnedByMember() { return { broadcast: null, probeKind: 'not_found' as const }; },
    async aggregateDeliveryCountsForBroadcast() {
      return { delivered: 0, bounced: 0, softBounced: 0, complained: 0, sent: 0 };
    },
    async pruneExpiredDrafts() { return { prunedDrafts: [] }; },
    async listInFlightOwnedByMember() { return []; },
    async listTerminalWithResendIdOwnedByMember() { return []; },
    async scrubContentForMemberInTx() { return { scrubbedCount: 0 }; },
    async tombstoneDeliveriesForMemberInTx() { return { tombstonedCount: 0 }; },
    async listMemberResendAudienceContactsInTx() { return []; },
    async redactMemberEmailFromCustomRecipientsInTx() { return { redactedCount: 0 }; },
    async listTerminalBroadcastsWithLiveAudience(tenantId, graceCutoff, limit) {
      listCalls.push({ tenantId, graceCutoff, limit });
      if (opts.shouldThrowOnList) throw new Error('Neon: connection lost');
      // Spec 139 s2 — the row's requester rides along (the deleted row names it).
      return opts.candidates.map((c) => ({ requestedByMemberId: 'm-1', ...c }));
    },
    async markAudienceDeletedInTx(_tx, broadcastId) {
      markCalls.push(broadcastId);
    },
    async deleteExpiredForRetention() { throw new Error('not used in cleanup-orphaned-audiences fixture'); },
    async listExpiredForRetention() { throw new Error('not used in cleanup-orphaned-audiences fixture'); },
    async claimDispatchLease(): Promise<never> { throw new Error('spec 140 s2b dispatch lease: not used in this fixture'); },
    async checkDispatchLease(): Promise<never> { throw new Error('spec 140 s2b dispatch lease: not used in this fixture'); },
    async releaseDispatchLease(): Promise<never> { throw new Error('spec 140 s2b dispatch lease: not used in this fixture'); },
    async hasLiveDispatchLease(): Promise<never> { throw new Error('spec 140 s2b dispatch lease: not used in this fixture'); },
    async existingBroadcastIds() { throw new Error('not used in cleanup-orphaned-audiences fixture'); },
  };

  return { port, listCalls, markCalls };
}

/**
 * Minimal BroadcastsGatewayPort stub. `deleteAudience` is the only method
 * called by cleanupOrphanedAudiences; everything else throws.
 */
function makeGateway(opts: {
  /**
   * Keyed by audienceId: if value is an Error (or GatewayThrowable), the
   * call throws it; otherwise it resolves.
   */
  throws?: Record<string, Error>;
}): {
  port: BroadcastsGatewayPort;
  deleteCalls: Array<string>;
} {
  const deleteCalls: Array<string> = [];

  const port: BroadcastsGatewayPort = {
    async createAudience() { throw new Error('not used'); },
    // T086 — unused by this fixture; present so the stub still satisfies BroadcastsGatewayPort.
    async createContactImport() { throw new Error('not used'); },
    async getContactImport() { throw new Error('not used'); },
    async createBroadcast() { throw new Error('not used'); },
    async sendBroadcast() { throw new Error('not used'); },
    async retrieveBroadcast() { throw new Error('not used'); },
    async getAudienceContactCount() { return { count: 0, complete: false }; },
    async removeContactFromAudience() {
      return { kind: 'detached' as const }; throw new Error('not used'); },
    async deleteAudience(audienceId) {
      deleteCalls.push(audienceId);
      const err = opts.throws?.[audienceId];
      if (err !== undefined) throw err;
    },
    async deleteBroadcastOnce(): Promise<never> { throw new Error('deleteBroadcastOnce is not used here'); },
    async retrieveBroadcastOnce(): Promise<never> { throw new Error('retrieveBroadcastOnce is not used here'); },
    async deleteBroadcast() { throw new Error('not used'); },
    async listAudiences() { return { audiences: [], truncated: false }; },
  };

  return { port, deleteCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanupOrphanedAudiences (PR-2 Task 3)', () => {
  it('0 candidates → ok({ processed:0, deleted:0, failed:0 }) with no gateway or mark calls', async () => {
    const repo = makeRepo({ candidates: [] });
    const gateway = makeGateway({});

    const result = await cleanupOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, ...NO_DRAIN_DEPS },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ processed: 0, deleted: 0, failed: 0, orphans: NO_ORPHAN_RUN });
    }
    expect(gateway.deleteCalls).toHaveLength(0);
    expect(repo.markCalls).toHaveLength(0);
  });

  it('2 candidates: #1 resolves, #2 throws → { processed:2, deleted:1, failed:1 }; mark called for #1 only; throw does NOT propagate', async () => {
    const candidate1 = { broadcastId: 'bc-1111', resendAudienceId: 'aud-1111' };
    const candidate2 = { broadcastId: 'bc-2222', resendAudienceId: 'aud-2222' };

    const repo = makeRepo({ candidates: [candidate1, candidate2] });

    const retryableThrow = new GatewayThrowable({
      kind: 'retryable',
      subKind: 'server_5xx',
      reason: 'Resend 503: upstream overload',
    });
    const gateway = makeGateway({ throws: { 'aud-2222': retryableThrow } });

    const result = await cleanupOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, ...NO_DRAIN_DEPS },
      { graceMs: GRACE_MS, limit: 50 },
    );

    // Result shape
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ processed: 2, deleted: 1, failed: 1, orphans: NO_ORPHAN_RUN });
    }

    // Gateway called for BOTH candidates
    expect(gateway.deleteCalls).toHaveLength(2);
    expect(gateway.deleteCalls).toContain('aud-1111');
    expect(gateway.deleteCalls).toContain('aud-2222');

    // Mark called for #1 only (not #2 — the delete threw)
    expect(repo.markCalls).toHaveLength(1);
    expect(repo.markCalls[0]).toBe('bc-1111');
  });

  it('7 candidates across concurrency chunks: #4 throws → all 7 processed, deleted:6, failed:1 (Finding A — chunked Promise.allSettled)', async () => {
    // > CLEANUP_CONCURRENCY (5) candidates so the chunked loop runs at least
    // two chunks. One mid-chunk throw must NOT short-circuit the chunk or the
    // remaining chunk — every other candidate is still deleted+marked. This
    // is the parity-with-reconcile invariant (chunked Promise.allSettled,
    // per-item try/catch): an isolated failure does not block progress.
    const candidates = Array.from({ length: 7 }, (_, i) => ({
      broadcastId: `bc-${i}`,
      resendAudienceId: `aud-${i}`,
    }));

    const repo = makeRepo({ candidates });

    // The 4th candidate (index 3) throws a retryable gateway error.
    const retryableThrow = new GatewayThrowable({
      kind: 'retryable',
      subKind: 'server_5xx',
      reason: 'Resend 503: upstream overload',
    });
    const gateway = makeGateway({ throws: { 'aud-3': retryableThrow } });

    const result = await cleanupOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, ...NO_DRAIN_DEPS },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 7 processed, 6 deleted (all but #4), 1 failed (#4 only).
      expect(result.value).toEqual({ processed: 7, deleted: 6, failed: 1, orphans: NO_ORPHAN_RUN });
    }

    // Every candidate's delete was attempted (no short-circuit).
    expect(gateway.deleteCalls).toHaveLength(7);

    // Mark called for all 6 successes; the thrown candidate (#4) is NOT marked.
    expect(repo.markCalls).toHaveLength(6);
    expect(repo.markCalls).not.toContain('bc-3');
    // A candidate from the SECOND chunk (index ≥ 5) was still processed,
    // proving the throw in chunk 1 did not abort subsequent chunks.
    expect(repo.markCalls).toContain('bc-5');
    expect(repo.markCalls).toContain('bc-6');
  });

  it('runs candidates within a chunk concurrently (Finding A — observes >1 in-flight delete)', async () => {
    // Deterministic concurrency probe: each deleteAudience records the peak
    // number of simultaneously in-flight deletes, then blocks on a shared
    // gate. A strictly sequential loop peaks at 1; the chunked
    // Promise.allSettled (concurrency 5) must peak at >1. We seed exactly 5
    // candidates (one full chunk) and release the gate once all 5 are
    // in-flight — proving they run together, not one-at-a-time.
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      broadcastId: `cc-${i}`,
      resendAudienceId: `aud-cc-${i}`,
    }));
    const repo = makeRepo({ candidates });

    let inFlight = 0;
    let peakInFlight = 0;
    let entered = 0;
    let resolveAllInFlight: () => void = () => {};
    const allInFlight = new Promise<void>((resolve) => {
      resolveAllInFlight = resolve;
    });
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const gateway: BroadcastsGatewayPort = {
      async createAudience() { throw new Error('not used'); },
      // T086 — unused by this fixture; present so the stub still satisfies BroadcastsGatewayPort.
      async createContactImport() { throw new Error('not used'); },
      async getContactImport() { throw new Error('not used'); },
      async createBroadcast() { throw new Error('not used'); },
      async sendBroadcast() { throw new Error('not used'); },
      async retrieveBroadcast() { throw new Error('not used'); },
      async getAudienceContactCount() { return { count: 0, complete: false }; },
      async removeContactFromAudience() {
      return { kind: 'detached' as const }; throw new Error('not used'); },
      async deleteBroadcastOnce(): Promise<never> { throw new Error('deleteBroadcastOnce is not used here'); },
      async retrieveBroadcastOnce(): Promise<never> { throw new Error('retrieveBroadcastOnce is not used here'); },
      async deleteBroadcast() { throw new Error('not used'); },
      async listAudiences() { return { audiences: [], truncated: false }; },
      async deleteAudience() {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        entered++;
        if (entered === candidates.length) resolveAllInFlight();
        await gate;
        inFlight--;
      },
    };

    // Once all 5 deletes are concurrently in-flight, release the gate so they
    // can all complete. If the loop were sequential, only 1 would ever be
    // in-flight and `allInFlight` would never resolve → the gate never opens.
    void allInFlight.then(() => releaseGate());

    const result = await cleanupOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway, clock, ...NO_DRAIN_DEPS },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    // A sequential loop would peak at 1; chunked concurrency-5 peaks at 5.
    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBe(5);
  });

  it('graceCutoff = clock.now() - graceMs (passed to repo list)', async () => {
    const repo = makeRepo({ candidates: [] });
    const gateway = makeGateway({});

    await cleanupOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, ...NO_DRAIN_DEPS },
      { graceMs: GRACE_MS, limit: 25 },
    );

    expect(repo.listCalls).toHaveLength(1);
    const call = repo.listCalls[0]!;
    expect(call.tenantId).toBe('test-tenant');
    expect(call.graceCutoff.getTime()).toBe(EXPECTED_CUTOFF.getTime());
    expect(call.limit).toBe(25);
  });

  it('repo list throws → cleanup.server_error (outer catch)', async () => {
    const repo = makeRepo({ candidates: [], shouldThrowOnList: true });
    const gateway = makeGateway({});

    const result = await cleanupOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, ...NO_DRAIN_DEPS },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('cleanup.server_error');
      // Spec 140 s2c — the error CLASS, never the driver's message (review round 1: named errClass).
      expect(result.error.errClass).toBe('Error');
    }
  });
});

// ---------------------------------------------------------------------------
// Spec 139 s2 (DA2) — the terminal_cleanup row
// ---------------------------------------------------------------------------

describe('cleanupOrphanedAudiences — spec 139 s2: broadcast_audience_deleted before each delete', () => {
  const DELETED = 'broadcast_audience_deleted';
  const candidate = { broadcastId: 'bc-1111', resendAudienceId: 'aud-1111', requestedByMemberId: 'm-requester' };

  /** A lock wait past `lock_timeout` as Drizzle throws it: the driver's 55P03 at `.cause`. */
  const lockTimeout = () =>
    Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    });

  function harness(
    opts: {
      readonly alreadyDeleted?: boolean;
      readonly auditThrows?: 'storage' | 'storage_sqlstate' | 'invariant';
      readonly dedupeThrows?: 'lock_timeout';
    } = {},
  ) {
    const events: string[] = [];
    const rows: Array<{ eventType: string; tenantId: string | null; actorUserId: string; requestId: string | null; payload: Record<string, unknown> }> = [];
    const repo = makeRepo({ candidates: [candidate] });
    repo.port.hasAudienceDeletedAuditInTx = async (_tx, _t, audienceId) => {
      events.push(`dedupe:${audienceId}`);
      if (opts.dedupeThrows === 'lock_timeout') throw lockTimeout();
      return opts.alreadyDeleted === true;
    };
    const gateway = makeGateway({});
    const del = gateway.port.deleteAudience.bind(gateway.port);
    gateway.port.deleteAudience = async (id) => {
      events.push(`gw:deleteAudience:${id}`);
      return del(id);
    };
    const audit = {
      async emit(_tx: unknown, e: { eventType: string; tenantId: string | null; actorUserId: string; requestId: string | null; payload: Record<string, unknown> }) {
        if (opts.auditThrows === 'invariant') throw new AuditPortInvariantError(e.eventType, 'unregistered event type');
        if (opts.auditThrows === 'storage') throw new Error('53300 too many connections');
        if (opts.auditThrows === 'storage_sqlstate') {
          throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
        }
        events.push(`audit:${e.eventType}`);
        rows.push({ eventType: e.eventType, tenantId: e.tenantId, actorUserId: e.actorUserId, requestId: e.requestId, payload: e.payload });
      },
      async emitTyped(): Promise<never> {
        throw new Error('emitTyped is not used here');
      },
    };
    const run = () =>
      cleanupOrphanedAudiences(
        { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, ...NO_DRAIN_DEPS, audit },
        { graceMs: GRACE_MS, limit: 50 },
      );
    return { run, events, rows, repo, gateway };
  }

  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a terminal row past the grace: the deleted row (terminal_cleanup, the requester), then the delete', async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const h = harness();
    const result = await h.run();
    expect(result.ok && result.value.deleted).toBe(1);
    expect(h.events).toEqual(['dedupe:aud-1111', `audit:${DELETED}`, 'gw:deleteAudience:aud-1111']);
    expect(h.rows).toEqual([
      {
        eventType: DELETED,
        tenantId: tenant.slug,
        actorUserId: 'system:cron',
        requestId: null,
        payload: {
          broadcast_id: 'bc-1111',
          related_member_id: 'm-requester',
          resend_audience_id: 'aud-1111',
          reason: 'terminal_cleanup',
          leg: 'import',
          actor_role: 'system',
        },
      },
    ]);
    expect(counted).toHaveBeenCalledWith(tenant.slug, DELETED);
  });

  it('a segment that already has its deleted row (a restart wrote it) gets no second one; the delete still runs', async () => {
    const h = harness({ alreadyDeleted: true });
    await h.run();
    expect(h.rows).toEqual([]);
    expect(h.events).toEqual(['dedupe:aud-1111', 'gw:deleteAudience:aud-1111']);
  });

  it('a storage failure of the row logs ERROR and counts it, and the delete still runs', async () => {
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness({ auditThrows: 'storage' });
    const result = await h.run();
    expect(result.ok && result.value.deleted).toBe(1);
    expect(h.gateway.deleteCalls).toEqual(['aud-1111']);
    const lines = errorSpy.mock.calls.filter((c) => c[1] === 'broadcasts.audience_cleanup.audience_audit_lost');
    expect(lines.map((c) => c[0])).toEqual([
      expect.objectContaining({ eventType: DELETED, broadcastId: 'bc-1111', resendAudienceId: 'aud-1111', err: 'Error', severity: 'critical' }),
    ]);
    expect(failed).toHaveBeenCalledWith(DELETED, tenant.slug);
  });

  it('an adapter invariant error stops that delete (fail closed): counted failed, no Resend call', async () => {
    const h = harness({ auditThrows: 'invariant' });
    const result = await h.run();
    expect(result.ok && result.value).toMatchObject({ deleted: 0, failed: 1 });
    expect(h.gateway.deleteCalls).toEqual([]);
    expect(h.repo.markCalls).toEqual([]);
  });

  // Review round 1 (reliability LOW-2) — a wiring bug is an ERROR, not the WARN of a failed delete.
  // Review round 2 (code-review #5) — one line, from the row helper (with the event type).
  it('an adapter invariant error logs ERROR audit_invariant (ids, err, critical), not the delete_failed WARN', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const h = harness({ auditThrows: 'invariant' });
    await h.run();
    expect(errorSpy.mock.calls.filter((c) => c[1] === 'broadcasts.audience_cleanup.audit_invariant').map((c) => c[0])).toEqual([
      {
        tenantId: tenant.slug,
        broadcastId: 'bc-1111',
        resendAudienceId: 'aud-1111',
        eventType: DELETED,
        err: 'AuditPortInvariantError',
        severity: 'critical',
      },
    ]);
    expect(warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_cleanup.delete_failed')).toEqual([]);
  });

  // Review round 2 (code-review #3) — the lost line carries the SQLSTATE (`errLogFields`), never the message.
  it('a storage failure with a SQLSTATE logs it as `code` on the audience_audit_lost line', async () => {
    const h = harness({ auditThrows: 'storage_sqlstate' });
    await h.run();
    expect(errorSpy.mock.calls.filter((c) => c[1] === 'broadcasts.audience_cleanup.audience_audit_lost').map((c) => c[0])).toEqual([
      {
        tenantId: tenant.slug,
        broadcastId: 'bc-1111',
        resendAudienceId: 'aud-1111',
        eventType: DELETED,
        err: 'Error',
        code: '57014',
        severity: 'critical',
      },
    ]);
  });

  // Review round 2 (code-review #1/#4, reliability LOW-1) — a lock wait past
  // `lock_timeout` is not a known loss: another tx may be writing the row.
  it('a lock timeout on the dedupe logs the WARN audience_audit_lock_timeout and counts it; no ERROR, the delete still runs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness({ dedupeThrows: 'lock_timeout' });
    const result = await h.run();
    expect(result.ok && result.value).toMatchObject({ deleted: 1, failed: 0 });
    expect(h.gateway.deleteCalls).toEqual(['aud-1111']);
    expect(h.rows).toEqual([]);
    expect(warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_cleanup.audience_audit_lock_timeout').map((c) => c[0])).toEqual([
      { tenantId: tenant.slug, broadcastId: 'bc-1111', resendAudienceId: 'aud-1111', eventType: DELETED, err: 'Error', code: '55P03' },
    ]);
    expect(errorSpy.mock.calls.filter((c) => c[1] === 'broadcasts.audience_cleanup.audience_audit_lost')).toEqual([]);
    expect(failed).toHaveBeenCalledWith(DELETED, tenant.slug);
  });
});
