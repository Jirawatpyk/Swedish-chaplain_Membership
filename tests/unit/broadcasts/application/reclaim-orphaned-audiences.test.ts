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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reclaimOrphanedAudiences } from '@/modules/broadcasts/application/use-cases/reclaim-orphaned-audiences';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId, type BroadcastId } from '@/modules/broadcasts/domain/broadcast';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { BroadcastsGatewayPort } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { GatewayThrowable } from '@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway';
import { RESEND_CALL_TIMEOUT_MS, oneCallFitsBefore } from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { broadcastsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import { AuditPortInvariantError, type AudienceDeletedEmitInput } from '@/modules/broadcasts/application/ports/audit-port';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date('2026-06-22T12:00:00Z');
const GRACE_MS = 60 * 60 * 1000; // 1 hour grace window
// Audience created 2h ago — past grace (as Date, matching port shape)
const PAST_GRACE_DATE = new Date(FROZEN_NOW.getTime() - 2 * 60 * 60 * 1000);
// Audience created 30 min ago — within grace
const WITHIN_GRACE_DATE = new Date(FROZEN_NOW.getTime() - 30 * 60 * 1000);

const TENANT_SLUG = 'swecham';
const tenant = asTenantContext(TENANT_SLUG);
const clock = { now: (): Date => FROZEN_NOW };
/**
 * Spec 139 s2 — the audit dep. These cases' repo finds no disclosed row, so no
 * row is ever written (the delete is unattributed); the spec 139 cells at the
 * end drive the row.
 */
const NO_AUDIT = { async emitOnce() { return true; } };
/** Spec 140 DT5 — a deadline none of the legacy cases comes near. */
const FAR_DEADLINE = new Date(FROZEN_NOW.getTime() + 60 * 60 * 1000);

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
  existing: ReadonlySet<BroadcastId>;
  shouldThrow?: boolean;
  /**
   * Bug #16 — when provided, the repo stubs the newer
   * `referencedAudienceIdsForBroadcasts` method (map of live broadcastId → the
   * SET of every audience id that row references: broadcasts.resend_audience_id
   * UNION all batch_manifests.provider_audience_id) so reclaim can detect
   * crash-before-attach orphans (audience referenced nowhere) WITHOUT deleting a
   * live split broadcast's in-use per-batch audiences. When omitted, the method
   * is absent and reclaim falls back to the legacy existence check.
   */
  referencedMap?: ReadonlyMap<BroadcastId, ReadonlySet<string>>;
}): {
  port: BroadcastsRepo;
  existingCalls: Array<{ tenantId: string; ids: ReadonlyArray<BroadcastId> }>;
} {
  const existingCalls: Array<{ tenantId: string; ids: ReadonlyArray<BroadcastId> }> = [];

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
    async attachBroadcastId() {},
    async attachAudienceId() {},
    // Phase 9b (T147) — unused by this use case; present so the stub
    // still satisfies BroadcastsRepo.
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
    async listTerminalBroadcastsWithLiveAudience() {
      throw new Error('not used in reclaim-orphaned-audiences fixture');
    },
    async markAudienceDeletedInTx() {
      throw new Error('not used in reclaim-orphaned-audiences fixture');
    },
    async deleteExpiredForRetention() { throw new Error('not used in reclaim-orphaned-audiences fixture'); },
    async listExpiredForRetention() { throw new Error('not used in reclaim-orphaned-audiences fixture'); },
    async claimDispatchLease(): Promise<never> { throw new Error('spec 140 s2b dispatch lease: not used in this fixture'); },
    async checkDispatchLease(): Promise<never> { throw new Error('spec 140 s2b dispatch lease: not used in this fixture'); },
    async releaseDispatchLease(): Promise<never> { throw new Error('spec 140 s2b dispatch lease: not used in this fixture'); },
    async hasLiveDispatchLease(): Promise<never> { throw new Error('spec 140 s2b dispatch lease: not used in this fixture'); },
    async existingBroadcastIds(tenantId, ids) {
      existingCalls.push({ tenantId, ids });
      if (opts.shouldThrow) throw new Error('Neon: existingBroadcastIds connection lost');
      return opts.existing;
    },
  };

  // Bug #16 — attach the newer method ONLY when the test opts into it, so the
  // legacy tests exercise the existence-only fallback unchanged.
  if (opts.referencedMap !== undefined) {
    port.referencedAudienceIdsForBroadcasts = async (tenantId, ids) => {
      existingCalls.push({ tenantId, ids });
      if (opts.shouldThrow) {
        throw new Error('Neon: referencedAudienceIdsForBroadcasts connection lost');
      }
      return opts.referencedMap!;
    };
  }

  return { port, existingCalls };
}

/**
 * Minimal BroadcastsGatewayPort stub. `listAudiences` and `deleteAudience`
 * are instrumented; everything else throws on accidental call.
 */
function makeGateway(opts: {
  audiences: ReadonlyArray<{ id: string; name: string; createdAt: Date }>;
  /** Keyed by audienceId. If the value is an Error, the call throws it. */
  throws?: Record<string, Error>;
  /** If true, listAudiences() throws instead of returning the list. */
  listThrows?: boolean;
  /** Spec 140 DT5 — the gateway says its listing was cut. */
  listTruncated?: boolean;
  /** Spec 140 DT5 — runs on every deleteAudience call (to move a clock). */
  onDelete?: () => void;
}): {
  port: BroadcastsGatewayPort;
  deleteCalls: Array<string>;
  listInputs: Array<{ readonly deadlineAt: Date }>;
} {
  const deleteCalls: Array<string> = [];
  const listInputs: Array<{ readonly deadlineAt: Date }> = [];

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
    async deleteBroadcastOnce(): Promise<never> { throw new Error('deleteBroadcastOnce is not used here'); },
    async retrieveBroadcastOnce(): Promise<never> { throw new Error('retrieveBroadcastOnce is not used here'); },
    async deleteBroadcast() { throw new Error('not used'); },
    async listAudiences(input) {
      listInputs.push(input);
      if (opts.listThrows) throw new Error('Resend: list audiences 503');
      return { audiences: [...opts.audiences], truncated: opts.listTruncated ?? false };
    },
    async deleteAudience(audienceId) {
      deleteCalls.push(audienceId);
      opts.onDelete?.();
      const err = opts.throws?.[audienceId];
      if (err !== undefined) throw err;
    },
  };

  return { port, deleteCalls, listInputs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reclaimOrphanedAudiences (PR-2 Task 3)', () => {
  it('(a) audience past grace, broadcastId NOT in DB → deleted (orphaned===1, deleted===1)', async () => {
    // Audience whose broadcast row no longer exists in the DB.
    const audienceId = 'aud-aaa';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_DATE }],
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) }); // UUID_A is NOT in DB

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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
        truncated: false,
        deferredDeletes: 0,
      });
    }
    expect(gateway.deleteCalls).toContain(audienceId);
    expect(gateway.deleteCalls).toHaveLength(1);
  });

  it('(b) audience whose broadcastId IS in DB → NOT deleted (orphaned===0)', async () => {
    const audienceId = 'aud-bbb';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_B}`, createdAt: PAST_GRACE_DATE }],
    });
    // UUID_B IS in the DB (active broadcast row still exists)
    const repo = makeRepo({ existing: new Set([asBroadcastId(UUID_B)]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ orphaned: 0, deleted: 0 });
    }
    // deleteAudience must NOT have been called for a live broadcast
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  // ---- Bug #16: crash-before-attach orphan (row exists, references another
  //      audience) — the existence-only check kept these forever. ----------
  it('#16: row references THIS audience nowhere (stale duplicate) → the stale audience IS reclaimed', async () => {
    // Dispatch created audience A1 ("aud-a1"), crashed before attachAudienceId,
    // the next tick minted A2 ("aud-a2") and persisted THAT. Reclaim scans A1.
    const gateway = makeGateway({
      audiences: [
        { id: 'aud-a1', name: `broadcast-${TENANT_SLUG}-${UUID_B}`, createdAt: PAST_GRACE_DATE },
      ],
    });
    const repo = makeRepo({
      existing: new Set([asBroadcastId(UUID_B)]), // row DOES exist...
      referencedMap: new Map([[asBroadcastId(UUID_B), new Set(['aud-a2'])]]), // ...references A2, not A1
    });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ orphaned: 1, deleted: 1 });
    // The dangling A1 IS deleted (old row-existence check kept it forever).
    expect(gateway.deleteCalls).toEqual(['aud-a1']);
  });

  it('#16: row references NO audience (empty set) → the audience IS reclaimed', async () => {
    const gateway = makeGateway({
      audiences: [
        { id: 'aud-null', name: `broadcast-${TENANT_SLUG}-${UUID_C}`, createdAt: PAST_GRACE_DATE },
      ],
    });
    const repo = makeRepo({
      existing: new Set([asBroadcastId(UUID_C)]),
      referencedMap: new Map<BroadcastId, ReadonlySet<string>>([[asBroadcastId(UUID_C), new Set()]]),
    });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ orphaned: 1, deleted: 1 });
    expect(gateway.deleteCalls).toEqual(['aud-null']);
  });

  it('#16: row references THIS audience (healthy MVP) → NOT reclaimed', async () => {
    const gateway = makeGateway({
      audiences: [
        { id: 'aud-h', name: `broadcast-${TENANT_SLUG}-${UUID_D}`, createdAt: PAST_GRACE_DATE },
      ],
    });
    const repo = makeRepo({
      existing: new Set([asBroadcastId(UUID_D)]),
      referencedMap: new Map([[asBroadcastId(UUID_D), new Set(['aud-h'])]]),
    });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ orphaned: 0, deleted: 0 });
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  // Code-review regression guard: a LIVE multi-batch (US1 split) broadcast
  // stores its per-batch audience ids ONLY in batch_manifests.provider_audience_id
  // (broadcasts.resend_audience_id stays NULL). Those in-use batch audiences MUST
  // be in the referenced set and MUST NOT be deleted.
  it('#16: live multi-batch broadcast — per-batch audiences (in manifests) are NOT reclaimed', async () => {
    const gateway = makeGateway({
      audiences: [
        { id: 'aud-batch0', name: `broadcast-${TENANT_SLUG}-${UUID_E}-batch-0`, createdAt: PAST_GRACE_DATE },
        { id: 'aud-batch1', name: `broadcast-${TENANT_SLUG}-${UUID_E}-batch-1`, createdAt: PAST_GRACE_DATE },
      ],
    });
    const repo = makeRepo({
      existing: new Set([asBroadcastId(UUID_E)]),
      // broadcasts.resend_audience_id NULL; both batch audiences referenced via manifests.
      referencedMap: new Map([[asBroadcastId(UUID_E), new Set(['aud-batch0', 'aud-batch1'])]]),
    });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ orphaned: 0, deleted: 0 });
    // Neither in-use batch audience is deleted (the pre-fix bug deleted both).
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  it('(c) General + different-tenant audience → skippedNonMatching===2, deleteAudience never called', async () => {
    const gateway = makeGateway({
      audiences: [
        { id: 'aud-gen', name: 'General', createdAt: PAST_GRACE_DATE },
        { id: 'aud-other', name: `broadcast-other-tenant-${UUID_A}`, createdAt: PAST_GRACE_DATE },
      ],
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_C}`, createdAt: WITHIN_GRACE_DATE }],
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) }); // UUID_C not in DB, but still within grace

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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
        { id: aud1Id, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_DATE },
        { id: aud2Id, name: `broadcast-${TENANT_SLUG}-${UUID_B}`, createdAt: PAST_GRACE_DATE },
      ],
      throws: {
        [aud1Id]: new GatewayThrowable({
          kind: 'retryable',
          subKind: 'server_5xx',
          reason: 'Resend 503: upstream overload',
        }),
      },
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) }); // neither UUID in DB

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_DATE }],
      throws: {
        [audienceId]: new Error('Cannot delete last audience'),
      },
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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

  it('(f2) the same refusal worded for a segment (resend@6.35 deletes at /segments) → benign skip', async () => {
    const audienceId = 'aud-last-seg';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_DATE }],
      throws: { [audienceId]: new Error('You cannot delete your last segment') },
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );
    expect(result.ok && result.value).toMatchObject({ failed: 0, skippedLastAudience: 1 });
  });

  it.each([
    'The last segment cannot be deleted',
    'Cannot remove the last segment',
  ])('(f4) other wordings of the refusal are a benign skip too: %s', async (message) => {
    const audienceId = 'aud-last-worded';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_DATE }],
      throws: { [audienceId]: new Error(message) },
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );
    expect(result.ok && result.value).toMatchObject({ failed: 0, skippedLastAudience: 1 });
  });

  it('(f3) a retryable failure whose text mentions a last segment is still a failure, not a skip', async () => {
    const audienceId = 'aud-not-last';
    const gateway = makeGateway({
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_DATE }],
      throws: {
        [audienceId]: new GatewayThrowable({
          kind: 'retryable',
          subKind: 'server_5xx',
          reason: 'upstream timeout while reading the last segment page',
        }),
      },
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );
    expect(result.ok && result.value).toMatchObject({ failed: 1, skippedLastAudience: 0 });
  });

  // ---------------------------------------------------------------------------
  // M-1 (review fix): existingBroadcastIds throwing → server_error, no deletes
  // ---------------------------------------------------------------------------

  it('(M-1) existingBroadcastIds throws → returns err reclaim.server_error and deletes nothing', async () => {
    // Safety gate: when the DB lookup throws, the use-case MUST abort immediately
    // and NOT call deleteAudience. Deleting without confirming the broadcast row
    // is absent would risk destroying live audiences.
    const gateway = makeGateway({
      audiences: [{ id: 'aud-aaa', name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_DATE }],
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]), shouldThrow: true });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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
      audiences: [{ id: audienceId, name: `broadcast-${TENANT_SLUG}-${UUID_B}`, createdAt: PAST_GRACE_DATE }],
      throws: {
        [audienceId]: new GatewayThrowable({
          kind: 'permanent',
          code: 'validation_error',
          reason: 'Cannot delete last audience',
        }),
      },
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) }); // UUID_B NOT in DB → orphan

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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
          createdAt: PAST_GRACE_DATE,
        },
      ],
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) }); // UUID_A not in DB

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
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
      createdAt: PAST_GRACE_DATE,
    }));
    const gateway = makeGateway({ audiences });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });

    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 2, deadlineAt: FAR_DEADLINE },
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

/**
 * Spec 140 DT5 — one per-invocation deadline covers the listing and the delete
 * chunks. The gateway stops paging inside it (pinned in the contract suite) and
 * says so with `truncated`; the use case starts a delete chunk only while one
 * bounded call (RESEND_CALL_TIMEOUT_MS) still fits, and counts the orphans it
 * did not reach as `deferredDeletes`. Both are counted on
 * `broadcasts_audience_reclaim_truncated_total{stage}`.
 */
describe('reclaimOrphanedAudiences — the time budget (spec 140 DT5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const orphanAudiences = (uuids: ReadonlyArray<string>) =>
    uuids.map((uuid, i) => ({ id: `aud-dt5-${i}`, name: `broadcast-${TENANT_SLUG}-${uuid}`, createdAt: PAST_GRACE_DATE }));

  it('hands its deadline to listAudiences', async () => {
    const gateway = makeGateway({ audiences: [] });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );
    expect(gateway.listInputs).toEqual([{ deadlineAt: FAR_DEADLINE }]);
  });

  it('a truncated listing is reported and counted, even with no candidate', async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'audienceReclaimTruncated');
    const gateway = makeGateway({ audiences: [{ id: 'aud-gen', name: 'General', createdAt: PAST_GRACE_DATE }], listTruncated: true });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );
    expect(result.ok && result.value).toMatchObject({ scanned: 1, orphaned: 0, truncated: true, deferredDeletes: 0 });
    expect(counted.mock.calls).toEqual([[TENANT_SLUG, 'listing']]);
  });

  it('a truncated listing still deletes the orphans it did see', async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'audienceReclaimTruncated');
    const gateway = makeGateway({ audiences: orphanAudiences([UUID_A]), listTruncated: true });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );
    expect(result.ok && result.value).toMatchObject({ orphaned: 1, deleted: 1, truncated: true, deferredDeletes: 0 });
    expect(counted.mock.calls).toEqual([[TENANT_SLUG, 'listing']]);
  });

  it('a chunk is not started once less than one call is left: its orphans are deferred, not failed', async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'audienceReclaimTruncated');
    // Seven orphans = a chunk of five, then one of two. The first chunk's
    // deletes move the clock to one millisecond short of a call before the
    // deadline, so the second chunk must not start.
    const deadlineAt = new Date(FROZEN_NOW.getTime() + 60_000);
    let now = FROZEN_NOW;
    const movingClock = { now: (): Date => now };
    const gateway = makeGateway({
      audiences: orphanAudiences([UUID_A, UUID_B, UUID_C, UUID_D, UUID_E, UUID_F, UUID_G]),
      onDelete: () => {
        now = new Date(deadlineAt.getTime() - RESEND_CALL_TIMEOUT_MS + 1);
      },
    });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock: movingClock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt },
    );
    expect(result.ok && result.value).toEqual({
      scanned: 7,
      orphaned: 7,
      deleted: 5,
      failed: 0,
      skippedLastAudience: 0,
      skippedNonMatching: 0,
      truncated: false,
      deferredDeletes: 2,
    });
    expect(gateway.deleteCalls).toHaveLength(5);
    expect(counted.mock.calls).toEqual([[TENANT_SLUG, 'deletes']]);
  });

  it('a deadline already inside one call defers every orphan and deletes none', async () => {
    const gateway = makeGateway({ audiences: orphanAudiences([UUID_A, UUID_B]) });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: new Date(FROZEN_NOW.getTime() + RESEND_CALL_TIMEOUT_MS - 1) },
    );
    expect(result.ok && result.value).toMatchObject({ orphaned: 2, deleted: 0, deferredDeletes: 2 });
    expect(gateway.deleteCalls).toHaveLength(0);
  });

  // Spec 142 (AO3) — the audit row's wait is no longer charged at the chunk
  // check: RECLAIM_DEADLINE_MARGIN_MS covers the DB work, and the delete is
  // bounded by RESEND_CALL_TIMEOUT_MS (spec 139 s2 review round 2 charged both).
  it('a chunk starts when the time left fits exactly one Resend call (the audit row is not charged)', async () => {
    const gateway = makeGateway({ audiences: orphanAudiences([UUID_A, UUID_B]) });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    const result = await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: new Date(FROZEN_NOW.getTime() + RESEND_CALL_TIMEOUT_MS) },
    );
    expect(result.ok && result.value).toMatchObject({ orphaned: 2, deleted: 2, deferredDeletes: 0 });
    expect(gateway.deleteCalls).toHaveLength(2);
  });

  it('a run inside its budget is not counted', async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'audienceReclaimTruncated');
    const gateway = makeGateway({ audiences: orphanAudiences([UUID_A]) });
    const repo = makeRepo({ existing: new Set<BroadcastId>([]) });
    await reclaimOrphanedAudiences(
      { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit: NO_AUDIT },
      { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
    );
    expect(counted).not.toHaveBeenCalled();
  });
});

// Spec 140 s3 review round 1 (R1-H) - the use case's chunk check and the
// gateway's page check judge the deadline with this one rule: start a call only
// while one whole bounded call still fits before the deadline.
describe('oneCallFitsBefore', () => {
  const deadline = new Date(100_000);
  it.each([
    ['exactly one budget left', 100_000 - RESEND_CALL_TIMEOUT_MS, true],
    ['more than one budget left', 0, true],
    ['one millisecond short of a budget', 100_000 - RESEND_CALL_TIMEOUT_MS + 1, false],
    ['past the deadline', 100_001, false],
  ])('%s -> %s', (_label, nowMs, fits) => {
    expect(oneCallFitsBefore(deadline, nowMs, RESEND_CALL_TIMEOUT_MS)).toBe(fits);
  });
});

// ---------------------------------------------------------------------------
// Spec 139 s2 (DA2, pdpa M-3) — the orphan_reclaim row, only when this tenant
// disclosed the segment
// ---------------------------------------------------------------------------

describe('reclaimOrphanedAudiences — spec 139 s2: broadcast_audience_deleted only for a segment this tenant disclosed', () => {
  const DELETED = 'broadcast_audience_deleted';
  const AUDIENCE = 'aud-orphan';

  afterEach(() => vi.restoreAllMocks());

  function harness(opts: {
    readonly disclosure?: { readonly broadcastId: string; readonly relatedMemberId: string } | 'throws' | null;
    readonly alreadyDeleted?: boolean;
    /** Spec 142 — emitOnce's answer for a disclosed segment with no deleted row yet: false = a row landed first. */
    readonly onceWrites?: boolean;
    readonly auditThrows?: 'invariant' | 'storage' | 'lock_timeout';
  }) {
    const events: string[] = [];
    const rows: Array<{ eventType: string; tenantId: string | null; actorUserId: string; requestId: string | null; payload: Record<string, unknown> }> = [];
    const gateway = makeGateway({
      audiences: [{ id: AUDIENCE, name: `broadcast-${TENANT_SLUG}-${UUID_A}`, createdAt: PAST_GRACE_DATE }],
    });
    const del = gateway.port.deleteAudience.bind(gateway.port);
    gateway.port.deleteAudience = async (id) => {
      events.push(`gw:deleteAudience:${id}`);
      return del(id);
    };
    // The referenced-audience read, stubbed explicitly: the row is gone, so
    // the segment is an orphan (no existence-only fallback).
    const repo = makeRepo({ existing: new Set<BroadcastId>(), referencedMap: new Map() });
    repo.port.findAudienceDisclosureInTx = async (_tx, _t, audienceId) => {
      events.push(`find:${audienceId}`);
      if (opts.disclosure === 'throws') throw new Error('57P01 terminating connection');
      return opts.disclosure ?? null;
    };
    // Spec 142 (AO3) — the reclaim's lockless read: no lock, no lock_timeout.
    // Review round 1 (code-review #5): read only when no disclosure names the
    // segment, to tell "already recorded" from unattributed.
    repo.port.hasAudienceDeletedAuditInTx = async (_tx, _t, audienceId) => {
      events.push(`dedupe:${audienceId}`);
      return opts.alreadyDeleted === true;
    };
    type Row = { eventType: string; tenantId: string | null; actorUserId: string; requestId: string | null; payload: Record<string, unknown> };
    const audit = {
      // A plain emit of the deleted row would bypass the index's arbiter.
      async emit(_tx: unknown, e: Row) {
        events.push(`audit:${e.eventType}`);
        rows.push({ eventType: e.eventType, tenantId: e.tenantId, actorUserId: e.actorUserId, requestId: e.requestId, payload: e.payload });
      },
      async emitOnce(_tx: unknown, input: AudienceDeletedEmitInput): Promise<boolean> {
        const e: Row = { ...input, payload: { ...input.payload } };
        if (opts.auditThrows === 'invariant') throw new AuditPortInvariantError(e.eventType, 'unregistered event type');
        if (opts.auditThrows === 'storage') throw new Error('53300 too many connections');
        // An INSERT wait past `lock_timeout` as Drizzle throws it: the driver's 55P03 at `.cause`.
        if (opts.auditThrows === 'lock_timeout') {
          throw Object.assign(new Error('Failed query'), {
            cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
          });
        }
        events.push(`audit-once:${e.eventType}`);
        // The index's answer: the key already holds its row.
        if (opts.onceWrites === false || opts.alreadyDeleted === true) return false;
        rows.push({ eventType: e.eventType, tenantId: e.tenantId, actorUserId: e.actorUserId, requestId: e.requestId, payload: e.payload });
        return true;
      },
    };
    const run = () =>
      reclaimOrphanedAudiences(
        { tenant, broadcastsRepo: repo.port, broadcastsGateway: gateway.port, clock, audit },
        { graceMs: GRACE_MS, limit: 50, deadlineAt: FAR_DEADLINE },
      );
    return { run, events, rows, gateway };
  }

  it("a disclosed row found: the deleted row (orphan_reclaim) copies ITS broadcast and requester, then the delete", async () => {
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const h = harness({ disclosure: { broadcastId: 'bc-disclosed', relatedMemberId: 'm-disclosed' } });
    const result = await h.run();
    expect(result.ok && result.value.deleted).toBe(1);
    // Review round 1 (code-review #5): the disclosure first, then emitOnce; no existence read.
    expect(h.events).toEqual([`find:${AUDIENCE}`, `audit-once:${DELETED}`, `gw:deleteAudience:${AUDIENCE}`]);
    expect(h.rows).toEqual([
      {
        eventType: DELETED,
        tenantId: TENANT_SLUG,
        actorUserId: 'system:cron',
        requestId: null,
        payload: {
          broadcast_id: 'bc-disclosed',
          related_member_id: 'm-disclosed',
          resend_audience_id: AUDIENCE,
          reason: 'orphan_reclaim',
          leg: 'import',
          actor_role: 'system',
        },
      },
    ]);
    expect(counted).toHaveBeenCalledWith(TENANT_SLUG, DELETED);
  });

  it('no disclosed row: no audit row, a warn (deleteReason never_disclosed, never a `reason` key) and the counter; the delete still runs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const unattributed = vi.spyOn(broadcastsMetrics, 'audienceReclaimDeleteUnattributed');
    const h = harness({ disclosure: null });
    await h.run();
    expect(h.rows).toEqual([]);
    // No disclosure: the existence read tells a recorded segment from an unattributed one.
    expect(h.events).toEqual([`find:${AUDIENCE}`, `dedupe:${AUDIENCE}`, `gw:deleteAudience:${AUDIENCE}`]);
    const lines = warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.delete_unattributed').map((c) => c[0] as Record<string, unknown>);
    expect(lines).toEqual([{ tenantId: TENANT_SLUG, resendAudienceId: AUDIENCE, deleteReason: 'never_disclosed' }]);
    expect(lines[0]).not.toHaveProperty('reason');
    expect(unattributed).toHaveBeenCalledWith(TENANT_SLUG);
  });

  it('a disclosed segment that already has its deleted row gets no second one (emitOnce false, no WARN); the delete still runs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const h = harness({ disclosure: { broadcastId: 'bc-disclosed', relatedMemberId: 'm-disclosed' }, alreadyDeleted: true });
    await h.run();
    expect(h.rows).toEqual([]);
    expect(h.events).toEqual([`find:${AUDIENCE}`, `audit-once:${DELETED}`, `gw:deleteAudience:${AUDIENCE}`]);
    expect(warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.delete_unattributed')).toEqual([]);
  });

  // Review round 1 (code-review #3) — e.g. cleanup's `terminal_cleanup` row for
  // a pre-s2 segment whose delete keeps failing: it is recorded, not unattributed.
  it('a segment already recorded as deleted is neither re-recorded nor reported unattributed', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const unattributed = vi.spyOn(broadcastsMetrics, 'audienceReclaimDeleteUnattributed');
    const h = harness({ disclosure: null, alreadyDeleted: true });
    await h.run();
    expect(h.rows).toEqual([]);
    expect(warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.delete_unattributed')).toEqual([]);
    expect(unattributed).not.toHaveBeenCalled();
    expect(h.events).toEqual([`find:${AUDIENCE}`, `dedupe:${AUDIENCE}`, `gw:deleteAudience:${AUDIENCE}`]);
  });

  // Spec 142 (plan fold-in, reliability L2; review round 1, code-review #5) —
  // for a disclosed segment the index is the dedupe: a row already there, or
  // one that lands first, makes emitOnce answer false, which is a skip.
  it('emitOnce answers false for a disclosed segment: a skip, no unattributed WARN, no count; the delete runs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const counted = vi.spyOn(broadcastsMetrics, 'auditEmitCount');
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const unattributed = vi.spyOn(broadcastsMetrics, 'audienceReclaimDeleteUnattributed');
    const h = harness({ disclosure: { broadcastId: 'bc-disclosed', relatedMemberId: 'm-disclosed' }, onceWrites: false });
    const result = await h.run();
    expect(result.ok && result.value).toMatchObject({ deleted: 1, failed: 0 });
    expect(h.rows).toEqual([]);
    expect(h.events).toEqual([`find:${AUDIENCE}`, `audit-once:${DELETED}`, `gw:deleteAudience:${AUDIENCE}`]);
    expect(warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.delete_unattributed')).toEqual([]);
    expect(unattributed).not.toHaveBeenCalled();
    expect(counted).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('an adapter storage error on the INSERT is the ERROR audience_audit_lost, not a skip; the delete runs', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness({ disclosure: { broadcastId: 'bc-disclosed', relatedMemberId: 'm-disclosed' }, auditThrows: 'storage' });
    const result = await h.run();
    expect(result.ok && result.value).toMatchObject({ deleted: 1, failed: 0 });
    expect(error.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.audience_audit_lost').map((c) => c[0])).toEqual([
      expect.objectContaining({ eventType: DELETED, resendAudienceId: AUDIENCE, err: 'Error', severity: 'critical' }),
    ]);
    expect(failed).toHaveBeenCalledWith(DELETED, TENANT_SLUG);
  });

  it('a failed disclosure read logs ERROR and counts a lost row, and the delete still runs', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const h = harness({ disclosure: 'throws' });
    await h.run();
    expect(h.gateway.deleteCalls).toEqual([AUDIENCE]);
    expect(error.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.audience_audit_lost').map((c) => c[0])).toEqual([
      expect.objectContaining({
        eventType: DELETED,
        broadcastId: null,
        resendAudienceId: AUDIENCE,
        segmentNameBroadcastId: UUID_A,
        err: 'Error',
        severity: 'critical',
      }),
    ]);
    expect(failed).toHaveBeenCalledWith(DELETED, TENANT_SLUG);
  });

  it('an adapter invariant error stops that delete (fail closed): counted failed, no Resend call', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const h = harness({ disclosure: { broadcastId: 'bc-disclosed', relatedMemberId: 'm-disclosed' }, auditThrows: 'invariant' });
    const result = await h.run();
    expect(result.ok && result.value).toMatchObject({ deleted: 0, failed: 1 });
    expect(h.gateway.deleteCalls).toEqual([]);
  });

  // Review round 1 (reliability LOW-2) — a wiring bug is an ERROR, not the WARN of a failed delete.
  it('an adapter invariant error logs ERROR audit_invariant (ids, err, critical), not the delete_failed WARN', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const h = harness({ disclosure: { broadcastId: 'bc-disclosed', relatedMemberId: 'm-disclosed' }, auditThrows: 'invariant' });
    await h.run();
    // Review round 2 (code-review #5) — one line, from the row helper: no broadcast
    // id (the segment name's is a guess, pdpa M-3), the segment as `resendAudienceId`.
    // Review round 3 (code-review #5): the name's id as a log-only field, so ops
    // can find the E-Blast; never on the record.
    expect(error.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.audit_invariant').map((c) => c[0])).toEqual([
      {
        tenantId: TENANT_SLUG,
        broadcastId: null,
        resendAudienceId: AUDIENCE,
        segmentNameBroadcastId: UUID_A,
        eventType: DELETED,
        err: 'AuditPortInvariantError',
        severity: 'critical',
      },
    ]);
    expect(warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.delete_failed')).toEqual([]);
  });

  // Review round 2 (code-review #1/#4, reliability LOW-1) — a timed-out segment
  // writes no row and no unattributed WARN this run; the next run retries.
  // Spec 142: the wait is now the INSERT's, on another tx's uncommitted insert.
  it('a lock timeout on the INSERT logs the WARN audience_audit_lock_timeout and counts it; no unattributed WARN, the delete still runs', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const failed = vi.spyOn(broadcastsMetrics, 'auditEmitFailed');
    const unattributed = vi.spyOn(broadcastsMetrics, 'audienceReclaimDeleteUnattributed');
    const h = harness({ disclosure: { broadcastId: 'bc-disclosed', relatedMemberId: 'm-disclosed' }, auditThrows: 'lock_timeout' });
    const result = await h.run();
    expect(result.ok && result.value).toMatchObject({ deleted: 1, failed: 0 });
    expect(h.rows).toEqual([]);
    expect(h.events).toEqual([`find:${AUDIENCE}`, `gw:deleteAudience:${AUDIENCE}`]);
    expect(warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.audience_audit_lock_timeout').map((c) => c[0])).toEqual([
      {
        tenantId: TENANT_SLUG,
        broadcastId: null,
        resendAudienceId: AUDIENCE,
        segmentNameBroadcastId: UUID_A,
        eventType: DELETED,
        err: 'Error',
        code: '55P03',
      },
    ]);
    expect(warn.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.delete_unattributed')).toEqual([]);
    expect(unattributed).not.toHaveBeenCalled();
    expect(error.mock.calls.filter((c) => c[1] === 'broadcasts.audience_reclaim.audience_audit_lost')).toEqual([]);
    expect(failed).toHaveBeenCalledWith(DELETED, TENANT_SLUG);
  });
});
