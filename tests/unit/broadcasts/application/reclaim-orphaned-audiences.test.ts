/**
 * PR-2 Task 3 — Unit tests for `reclaim-orphaned-audiences.ts` Application
 * use-case (orphan-reclaim: deletes Resend audiences whose local broadcast
 * row no longer exists in the DB).
 *
 * Complements `cleanup-orphaned-audiences` (which handles audiences WITH a
 * broadcast row that has reached terminal status). This use-case handles the
 * deeper class of orphan: a Resend audience whose entire broadcast row is gone
 * (purged, crashed mid-dispatch, or leaked by a failed cleanup sequence).
 *
 * Covers:
 *   (a) Audience past grace, broadcastId NOT in DB → deleted (deleteAudience
 *       called; deleted===1, orphaned===1).
 *   (b) Audience whose broadcastId IS in DB → NOT deleted (deleteAudience NOT
 *       called; orphaned===0).
 *   (c) `General` + a different-tenant audience → skippedNonMatching counted,
 *       deleteAudience never called.
 *   (d) Audience matching slug but createdAt within grace → not a candidate,
 *       not deleted.
 *   (e) Two orphans, deleteAudience throws for the first → failed===1, second
 *       still deleted===1 (throw isolation under Promise.allSettled).
 *   (f) deleteAudience throws "Cannot delete last audience" → benign skip
 *       (failed===0, deleted===0 for it).
 *   (g) listAudiences throws → returns err reclaim.server_error.
 *
 * Project memory: `mock-only-tests-miss-throw-paths` — the per-item try/catch
 * + throw-path test (e) are MANDATORY; (f) tests the benign-skip path for
 * Resend's "Cannot delete last audience" 403.
 */
import { describe, expect, it } from 'vitest';

import { reclaimOrphanedAudiences } from '@/modules/broadcasts/application/use-cases/reclaim-orphaned-audiences';
import { asTenantContext } from '@/modules/tenants';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { GatewayThrowable } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date('2026-06-22T12:00:00Z');
const GRACE_MS = 60 * 60 * 1000; // 1 hour grace window
// Audience created 2h ago — past grace
const PAST_GRACE_ISO = new Date(FROZEN_NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
// Audience created 30 min ago — within grace
const WITHIN_GRACE_ISO = new Date(FROZEN_NOW.getTime() - 30 * 60 * 1000).toISOString();

const TENANT_SLUG = 'swecham';
const tenant = asTenantContext(TENANT_SLUG);
const clock = { now: (): Date => FROZEN_NOW };

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';
const UUID_D = '44444444-4444-4444-4444-444444444444';
const UUID_E = '55555555-5555-5555-5555-555555555555';
const UUID_F = '66666666-6666-6666-6666-666666666666';
const UUID_G = '77777777-7777-7777-7777-777777777777';
const UUID_H = '88888888-8888-8888-8888-888888888888';

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/**
 * Minimal BroadcastsRepo stub. Only `existingBroadcastIds` is instrumented;
 * every method used by cleanup-orphaned-audiences that reclaimOrphanedAudiences
 * does NOT call must throw so an accidental call is caught immediately.
 */
function makeRepo(opts: {
  existing: ReadonlySet<string>;
  shouldThrow?: boolean;
}): {
  port: BroadcastsRepo;
  existingCalls: Array<{ tenantId: string; ids: ReadonlyArray<string> }>;
} {
  const existingCalls: Array<{ tenantId: string; ids: ReadonlyArray<string> }> = [];

  const port: BroadcastsRepo = {
    async withTx(fn) { return fn({}); },
    async insertDraft() { throw new Error('not used in reclaim-orphaned-audiences fixture'); },
    async updateDraft() { throw new Error('not used in reclaim-orphaned-audiences fixture'); },
    async updateDraftFromTemplate() { throw new Error('not used in reclaim-orphaned-audiences fixture'); },
    async findById() { return null; },
    async findByIdInTx() { return null; },
    async lockForUpdate() { return null; },
    async applyTransition() { throw new Error('not used in reclaim-orphaned-audiences fixture'); },
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
    async listTerminalBroadcastsWithLiveAudience() {
      throw new Error('not used in reclaim-orphaned-audiences fixture');
    },
    async markAudienceDeletedInTx() {
      throw new Error('not used in reclaim-orphaned-audiences fixture');
    },
    async existingBroadcastIds(tenantId, ids) {
      existingCalls.push({ tenantId, ids });
      if (opts.shouldThrow) throw new Error('Neon: existingBroadcastIds connection lost');
      return opts.existing;
    },
  };

  return { port, existingCalls };
}

/**
 * Minimal BroadcastsGatewayPort stub. `listAudiences` and `deleteAudience`
 * are instrumented; everything else throws on accidental call.
 */
function makeGateway(opts: {
  audiences: ReadonlyArray<{ id: string; name: string; createdAt: string }>;
  /** Keyed by audienceId. If the value is an Error, the call throws it. */
  throws?: Record<string, Error>;
  /** If true, listAudiences() throws instead of returning the list. */
  listThrows?: boolean;
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
    async listAudiences() {
      if (opts.listThrows) throw new Error('Resend: list audiences 503');
      return [...opts.audiences];
    },
    async deleteAudience(audienceId) {
      deleteCalls.push(audienceId);
      const err = opts.throws?.[audienceId];
      if (err !== undefined) throw err;
    },
  };

  return { port, deleteCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reclaimOrphanedAudiences (PR-2 Task 3)', () => {
  it('(a) audience past grace, broadcastId NOT in DB → deleted (orphaned===1, deleted===1)', async () => {
    // Audience whose broadcast row no longer exists in the DB.
    const audienceId = 'aud-aaa';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_ISO }],
    });
    const repo = makeRepo({ existing: new Set([]) }); // UUID_A is NOT in DB

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        scanned: 1,
        orphaned: 1,
        deleted: 1,
        failed: 0,
        skippedLastAudience: 0,
        skippedNonMatching: 0,
      });
    }
    expect(gateway.deleteCalls).toContain(audienceId);
    expect(gateway.deleteCalls).toHaveLength(1);
  });

  it('(b) audience whose broadcastId IS in DB → NOT deleted (orphaned===0)', async () => {
    const audienceId = 'aud-bbb';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_B}`, createdAt: PAST_GRACE_ISO }],
    });
    // UUID_B IS in the DB (active broadcast row still exists)
    const repo = makeRepo({ existing: new Set([UUID_B]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ orphaned: 0, deleted: 0 });
    }
    // deleteAudience must NOT have been called for a live broadcast
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  it('(c) General + different-tenant audience → skippedNonMatching===2, deleteAudience never called', async () => {
    const gateway = makeGateway({
      audiences: [
        { id: 'aud-gen', name: 'General', createdAt: PAST_GRACE_ISO },
        { id: 'aud-other', name: `broadcast-other-tenant-${UUID_A}`, createdAt: PAST_GRACE_ISO },
      ],
    });
    const repo = makeRepo({ existing: new Set([]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        scanned: 2,
        orphaned: 0,
        deleted: 0,
        failed: 0,
        skippedNonMatching: 2,
      });
    }
    expect(gateway.deleteCalls).toHaveLength(0);
    // existingBroadcastIds should not be called since there are no candidates
    expect(repo.existingCalls).toHaveLength(0);
  });

  it('(d) audience matching slug but createdAt within grace → not a candidate, not deleted', async () => {
    const audienceId = 'aud-fresh';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_C}`, createdAt: WITHIN_GRACE_ISO }],
    });
    const repo = makeRepo({ existing: new Set([]) }); // UUID_C not in DB, but still within grace

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        scanned: 1,
        orphaned: 0,
        deleted: 0,
        failed: 0,
        skippedNonMatching: 0, // it MATCHED the slug pattern; just too fresh
      });
    }
    expect(gateway.deleteCalls).toHaveLength(0);
    // No candidates past grace → existingBroadcastIds should not be called
    expect(repo.existingCalls).toHaveLength(0);
  });

  it('(e) two orphans, deleteAudience throws for the first → failed===1, second still deleted===1 (throw isolation)', async () => {
    // Both audiences are past grace and have NO matching DB rows.
    const aud1Id = 'aud-e1';
    const aud2Id = 'aud-e2';
    const gateway = makeGateway({
      audiences: [
        { id: aud1Id, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_ISO },
        { id: aud2Id, name: `broadcast-${TENANT_SLUG}-${UUID_B}`, createdAt: PAST_GRACE_ISO },
      ],
      throws: {
        [aud1Id]: new GatewayThrowable({
          kind: 'retryable',
          subKind: 'server_5xx',
          reason: 'Resend 503: upstream overload',
        }),
      },
    });
    const repo = makeRepo({ existing: new Set([]) }); // neither UUID in DB

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        orphaned: 2,
        deleted: 1,
        failed: 1,
      });
    }
    // Both delete calls were attempted (throw did not abort the batch)
    expect(gateway.deleteCalls).toContain(aud1Id);
    expect(gateway.deleteCalls).toContain(aud2Id);
  });

  it('(f) deleteAudience throws "Cannot delete last audience" → benign skip (failed===0, deleted===0 for it)', async () => {
    const audienceId = 'aud-last';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_ISO }],
      throws: {
        [audienceId]: new Error('Cannot delete last audience'),
      },
    });
    const repo = makeRepo({ existing: new Set([]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The "cannot delete last audience" case is benign — treated as a skip,
      // not a failure. This is a Resend 403 validation that means we can't
      // delete it right now (it's the account's last audience); it will be
      // eligible once another audience exists. Not counted as failed.
      // Invariant: orphaned === deleted + failed + skippedLastAudience (1 === 0 + 0 + 1).
      expect(result.value.orphaned).toBe(1);
      expect(result.value.deleted).toBe(0);
      expect(result.value.failed).toBe(0);
      expect(result.value.skippedLastAudience).toBe(1);
    }
  });

  // ---------------------------------------------------------------------------
  // M-1 (review fix): existingBroadcastIds throwing → server_error, no deletes
  // ---------------------------------------------------------------------------

  it('(M-1) existingBroadcastIds throws → returns err reclaim.server_error and deletes nothing', async () => {
    // Safety gate: when the DB lookup throws, the use-case MUST abort immediately
    // and NOT call deleteAudience. Deleting without confirming the broadcast row
    // is absent would risk destroying live audiences.
    const gateway = makeGateway({
      audiences: [{ id: 'aud-aaa', name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_ISO }],
    });
    const repo = makeRepo({ existing: new Set([]), shouldThrow: true });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('reclaim.server_error');
    // SAFETY: deleteAudience must NOT be called when the DB lookup fails
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // M-2 (review fix): "Cannot delete last audience" via real GatewayThrowable
  // ---------------------------------------------------------------------------

  it('(M-2) deleteAudience throws GatewayThrowable("Cannot delete last audience") → benign skip (failed stays 0)', async () => {
    // Production shape: Resend returns a 403 → gateway throws GatewayThrowable
    // (not a plain Error). Its constructor calls super(init.reason) so
    // .message === reason. The LAST_AUDIENCE_PATTERN (/cannot delete last audience/i)
    // in the use-case matches via `e instanceof Error && LAST_AUDIENCE_PATTERN.test(e.message)`,
    // which GatewayThrowable satisfies because it extends Error.
    const audienceId = 'aud-last-gw';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_B}`, createdAt: PAST_GRACE_ISO }],
      throws: {
        [audienceId]: new GatewayThrowable({
          kind: 'permanent',
          code: 'validation_error',
          reason: 'Cannot delete last audience',
        }),
      },
    });
    const repo = makeRepo({ existing: new Set([]) }); // UUID_B NOT in DB → orphan

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ orphaned: 1, deleted: 0, failed: 0 });
    }
    // deleteAudience WAS called (the attempt was made) but the throw was benign
    expect(gateway.deleteCalls).toContain(audienceId);
  });

  it('(g) listAudiences throws → returns err reclaim.server_error', async () => {
    const gateway = makeGateway({ audiences: [], listThrows: true });
    const repo = makeRepo({ existing: new Set([]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('reclaim.server_error');
      expect(result.error.message).toContain('list audiences');
    }
  });

  it('batch-with-batch audience names also matched (e.g. broadcast-swecham-<uuid>-batch-0)', async () => {
    // dispatch creates batch audiences with a -batch-N suffix; those are also
    // eligible for reclaim (not skipped as non-matching).
    const audienceId = 'aud-batch';
    const gateway = makeGateway({
      audiences: [
        {
          id: audienceId,
          name: `broadcast-${TENANT_SLUG}-${UUID_A}-batch-0`,
          createdAt: PAST_GRACE_ISO,
        },
      ],
    });
    const repo = makeRepo({ existing: new Set([]) }); // UUID_A not in DB

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 50 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ orphaned: 1, deleted: 1, skippedNonMatching: 0 });
    }
    expect(gateway.deleteCalls).toContain(audienceId);
  });

  it('(N-1) limit caps candidates before the DB existence check — exact count asserted', async () => {
    // 5 audiences with DISTINCT broadcast IDs (UUID_D…UUID_H), all orphaned
    // (no DB rows), limit=2 → exactly 2 are candidates and deleted.
    // Distinct UUIDs ensure the dedup step (Set over broadcastIds) does NOT
    // reduce the candidate count unexpectedly — the limit-vs-dedup interaction
    // is what this test guards. Using toBe(2) (not toBeLessThanOrEqual) so an
    // impl that ignores `limit` and deletes all 5 would fail here.
    const distinctIds = [UUID_D, UUID_E, UUID_F, UUID_G, UUID_H];
    const audiences = distinctIds.map((uuid, i) => ({
      id: `aud-lim-${i}`,
      name: `broadcast-${TENANT_SLUG}-${uuid}`,
      createdAt: PAST_GRACE_ISO,
    }));
    const gateway = makeGateway({ audiences });
    const repo = makeRepo({ existing: new Set([]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock },
      { graceMs: GRACE_MS, limit: 2 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // scanned all 5 but only considered 2 as candidates (capped by limit)
      expect(result.value.scanned).toBe(5);
      expect(result.value.orphaned).toBe(2);
      expect(result.value.deleted).toBe(2);
      expect(gateway.deleteCalls).toHaveLength(2); // exact, not ≤
    }
  });
});
