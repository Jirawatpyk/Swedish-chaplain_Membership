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
import { describe, expect, it } from 'vitest';

import { cleanupOrphanedAudiences } from '@/modules/broadcasts/application/use-cases/cleanup-orphaned-audiences';
import { asTenantContext } from '@/modules/tenants';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { GatewayThrowable } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date('2026-06-21T12:00:00Z');
const GRACE_MS = 60 * 60 * 1000; // 1 hour
const EXPECTED_CUTOFF = new Date(FROZEN_NOW.getTime() - GRACE_MS);

const tenant = asTenantContext('test-tenant');
const clock = { now: (): Date => FROZEN_NOW };

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
    async attachAudienceId() {},
    async listByTenantStatus() { return { rows: [], nextCursor: null }; },
    async countForMemberQuota() { return { submittedOrApproved: 0, sent: 0 }; },
    async findByResendBroadcastIdBypassRls() { return null; },
    async listForMemberPaginated() { return { rows: [], total: 0, totalPages: 0, page: 1 }; },
    async findOwnedByMember() { return { broadcast: null, probeKind: 'not_found' as const }; },
    async aggregateDeliveryCountsForBroadcast() {
      return { delivered: 0, bounced: 0, softBounced: 0, complained: 0, sent: 0 };
    },
    async pruneExpiredDrafts() { return { prunedCount: 0 }; },
    async listInFlightOwnedByMember() { return []; },
    async scrubContentForMemberInTx() { return { scrubbedCount: 0 }; },
    async tombstoneDeliveriesForMemberInTx() { return { tombstonedCount: 0 }; },
    async listMemberResendAudienceContactsInTx() { return []; },
    async redactMemberEmailFromCustomRecipientsInTx() { return { redactedCount: 0 }; },
    async listTerminalBroadcastsWithLiveAudience(tenantId, graceCutoff, limit) {
      listCalls.push({ tenantId, graceCutoff, limit });
      if (opts.shouldThrowOnList) throw new Error('Neon: connection lost');
      return [...opts.candidates];
    },
    async markAudienceDeletedInTx(_tx, broadcastId) {
      markCalls.push(broadcastId);
    },
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
    async addContactsToAudience() { throw new Error('not used'); },
    async createBroadcast() { throw new Error('not used'); },
    async sendBroadcast() { throw new Error('not used'); },
    async retrieveBroadcast() { throw new Error('not used'); },
    async getAudienceContactCount() { return { kind: 'not_found' as const }; },
    async removeContactFromAudience() { throw new Error('not used'); },
    async deleteAudience(audienceId) {
      deleteCalls.push(audienceId);
      const err = opts.throws?.[audienceId];
      if (err !== undefined) throw err;
    },
    async listAudiences() { return []; },
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
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ processed: 0, deleted: 0, failed: 0 });
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
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    // Result shape
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ processed: 2, deleted: 1, failed: 1 });
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
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 7 processed, 6 deleted (all but #4), 1 failed (#4 only).
      expect(result.value).toEqual({ processed: 7, deleted: 6, failed: 1 });
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
      async addContactsToAudience() { throw new Error('not used'); },
      async createBroadcast() { throw new Error('not used'); },
      async sendBroadcast() { throw new Error('not used'); },
      async retrieveBroadcast() { throw new Error('not used'); },
      async getAudienceContactCount() { return { kind: 'not_found' as const }; },
      async removeContactFromAudience() { throw new Error('not used'); },
      async listAudiences() { return []; },
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
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway, clock },
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
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
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
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('cleanup.server_error');
      expect(result.error.message).toContain('Neon');
    }
  });
});
