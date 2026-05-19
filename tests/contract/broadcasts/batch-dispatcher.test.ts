/**
 * Phase 3F.10 (2026-05-19) — Contract test for `dispatchAllPendingBatches`
 * (T046 service). Closes coverage gap pr-test-analyzer Finding 2: the
 * concurrency-cap clamp + per-batch failure isolation + deterministic
 * sort had zero direct test coverage prior to this commit.
 *
 * Scope excludes timing-dependent peak-in-flight assertions — those
 * are fragile across CI workers under load. Instead we verify the
 * orchestration invariants: (1) empty input → zero outcomes; (2) bad
 * concurrency cap (NaN, negative, > MAX) still completes — clamp is
 * defence-in-depth; (3) per-batch failure isolated — pool keeps going;
 * (4) results sorted by batchIndex regardless of completion order.
 */
import { describe, expect, it } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asIdempotencyKey } from '@/modules/broadcasts/domain/value-objects/idempotency-key';
import { dispatchAllPendingBatches } from '@/modules/broadcasts/application/services/batch-dispatcher';
import type { BatchManifest } from '@/modules/broadcasts/application/ports/batch-manifests-port';
import type { TenantSlug } from '@/modules/tenants';

const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

function makeManifest(overrides: Partial<BatchManifest> = {}): BatchManifest {
  return {
    id: 'batch-id-1',
    tenantId: 'test-tenant' as TenantSlug,
    broadcastId,
    batchIndex: 0,
    recipientCount: 3,
    recipientRangeStart: 0,
    recipientRangeEnd: 2,
    status: 'pending',
    providerAudienceId: null,
    providerBroadcastId: null,
    idempotencyKey: asIdempotencyKey('broadcast-aaa-batch-0-attempt-0'),
    retryCount: 0,
    deliveredCount: 0,
    bouncedCount: 0,
    complainedCount: 0,
    unsubscribedCount: 0,
    dispatchedAt: null,
    failedAt: null,
    failureReason: null,
    createdAt: new Date('2026-06-15T05:00:00Z'),
    updatedAt: new Date('2026-06-15T05:00:00Z'),
    ...overrides,
  };
}

const broadcastContent = {
  broadcastId,
  subject: 'Test',
  bodyHtml: '<p>body</p>',
  fromName: 'Test From',
  fromEmail: 'from@example.com',
  replyToEmail: 'reply@example.com',
  tenantDisplayName: 'Test Tenant',
  locale: 'en' as const,
};

const allRecipients = Array.from({ length: 30 }, (_, i) => ({
  emailLower: `r${i}@example.com`,
}));

/**
 * Stub deps. `failOnAudienceNames` — if `createAudience` is called
 * with one of these names, it throws synchronously so the use case
 * transitions that batch to `failed`.
 *
 * AudienceName format from the use case:
 *   `broadcast-{tenantSlug}-{broadcastId}-batch-{batchIndex}`
 */
function makeStubDeps(opts: {
  manifests: ReadonlyArray<BatchManifest>;
  failOnAudienceNames?: ReadonlySet<string>;
  /**
   * Phase 3F.11.4 (Round 2 test gap) — staggered-delay support. When
   * provided, `createAudience` delays its resolution by the lookup
   * (audienceName → ms delay). Used by the staggered-sort test to
   * force completion-order to invert vs enqueue-order, which exercises
   * `results.sort((a, b) => a.batchIndex - b.batchIndex)` non-trivially.
   */
  delayByAudienceName?: ReadonlyMap<string, number>;
}): unknown {
  return {
    batchManifests: {
      async findByBroadcast() {
        return opts.manifests;
      },
      async updateStatus(
        _t: unknown,
        _id: unknown,
        _update: { status: string },
      ) {
        return { ok: true, value: opts.manifests[0]! };
      },
    },
    gateway: {
      async createAudience(audienceName: string) {
        if (opts.failOnAudienceNames?.has(audienceName)) {
          throw new Error(`createAudience-boom-${audienceName}`);
        }
        const delay = opts.delayByAudienceName?.get(audienceName);
        if (delay !== undefined && delay > 0) {
          await new Promise((res) => setTimeout(res, delay));
        }
        return { audienceId: `aud-${audienceName}` };
      },
      async addContactsToAudience() {
        /* no-op */
      },
      async createBroadcast(_args: { audienceId: string }) {
        return { broadcastId: `resend-bid-${_args.audienceId}` };
      },
      async sendBroadcast() {
        /* no-op */
      },
    },
    advisoryLock: {
      async acquire() {
        return { acquired: true };
      },
    },
    audit: {
      async emit() {
        /* no-op */
      },
    },
    clock: { now: () => new Date('2026-06-15T05:00:00Z') },
  };
}

describe('dispatchAllPendingBatches contract (Phase 3F.10)', () => {
  it('empty pendingBatches → zero outcomes, returns summary', async () => {
    const deps = makeStubDeps({ manifests: [] });

    const result = await dispatchAllPendingBatches(deps as never, {
      tenantId: tenant,
      broadcastContent,
      allRecipients: [],
      pendingBatches: [],
      concurrencyCap: 4,
    });

    expect(result.totalBatches).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('NaN concurrencyCap → still completes (clamp to default)', async () => {
    const manifests = Array.from({ length: 3 }, (_, i) =>
      makeManifest({
        id: `batch-${i}`,
        batchIndex: i,
        recipientRangeStart: i * 3,
        recipientRangeEnd: i * 3 + 2,
        recipientCount: 3,
      }),
    );
    const deps = makeStubDeps({ manifests });

    const result = await dispatchAllPendingBatches(deps as never, {
      tenantId: tenant,
      broadcastContent,
      allRecipients: allRecipients.slice(0, 9),
      pendingBatches: manifests,
      concurrencyCap: Number.NaN,
    });

    expect(result.totalBatches).toBe(3);
    expect(result.succeeded).toBe(3);
  });

  it('negative concurrencyCap → still completes (clamp to default)', async () => {
    const manifests = Array.from({ length: 2 }, (_, i) =>
      makeManifest({
        id: `batch-${i}`,
        batchIndex: i,
        recipientRangeStart: i * 3,
        recipientRangeEnd: i * 3 + 2,
        recipientCount: 3,
      }),
    );
    const deps = makeStubDeps({ manifests });

    const result = await dispatchAllPendingBatches(deps as never, {
      tenantId: tenant,
      broadcastContent,
      allRecipients: allRecipients.slice(0, 6),
      pendingBatches: manifests,
      concurrencyCap: -5,
    });

    expect(result.totalBatches).toBe(2);
    expect(result.succeeded).toBe(2);
  });

  it('concurrencyCap > MAX_CONCURRENCY_CAP → clamped to 8 (still completes)', async () => {
    const manifests = Array.from({ length: 2 }, (_, i) =>
      makeManifest({
        id: `batch-${i}`,
        batchIndex: i,
        recipientRangeStart: i * 3,
        recipientRangeEnd: i * 3 + 2,
        recipientCount: 3,
      }),
    );
    const deps = makeStubDeps({ manifests });

    const result = await dispatchAllPendingBatches(deps as never, {
      tenantId: tenant,
      broadcastContent,
      allRecipients: allRecipients.slice(0, 6),
      pendingBatches: manifests,
      concurrencyCap: 1000,
    });

    expect(result.totalBatches).toBe(2);
    expect(result.succeeded).toBe(2);
  });

  it('per-batch failure isolated: 1 of 4 batches fails, pool keeps going', async () => {
    const manifests = Array.from({ length: 4 }, (_, i) =>
      makeManifest({
        id: `batch-${i}`,
        batchIndex: i,
        recipientRangeStart: i * 3,
        recipientRangeEnd: i * 3 + 2,
        recipientCount: 3,
      }),
    );
    const failAudienceName = `broadcast-${tenant.slug}-${broadcastId}-batch-2`;
    const deps = makeStubDeps({
      manifests,
      failOnAudienceNames: new Set([failAudienceName]),
    });

    const result = await dispatchAllPendingBatches(deps as never, {
      tenantId: tenant,
      broadcastContent,
      allRecipients: allRecipients.slice(0, 12),
      pendingBatches: manifests,
      concurrencyCap: 2,
    });

    expect(result.totalBatches).toBe(4);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(1);

    // Specifically batch-2 (index 2) is the failed one.
    const failedRow = result.results.find((r) => r.batchIndex === 2);
    expect(failedRow?.outcome.status).toBe('failed');
  });

  it('results sorted by batchIndex regardless of completion order', async () => {
    const manifests = Array.from({ length: 5 }, (_, i) =>
      makeManifest({
        id: `batch-${i}`,
        batchIndex: i,
        recipientRangeStart: i * 3,
        recipientRangeEnd: i * 3 + 2,
        recipientCount: 3,
      }),
    );
    const deps = makeStubDeps({ manifests });

    const result = await dispatchAllPendingBatches(deps as never, {
      tenantId: tenant,
      broadcastContent,
      allRecipients: allRecipients.slice(0, 15),
      pendingBatches: manifests,
      concurrencyCap: 5,
    });

    // Even though concurrencyCap=5 means all 5 workers might finish
    // out of order under load, the output is sorted by batchIndex.
    expect(result.results.map((r) => r.batchIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  // Phase 3F.11.4 (Round 2 test gap) — Inject batches in REVERSED
  // batchIndex order to verify the explicit `results.sort(...)` at
  // batch-dispatcher.ts:160 is doing real work. The previous
  // "results sorted by batchIndex" test passes trivially because
  // pendingBatches were already in batchIndex order — a regression
  // deleting the sort would still pass that test. This one feeds in
  // [4,3,2,1,0] order; only an explicit sort produces [0,1,2,3,4].
  //
  // NOTE: setTimeout-based staggered completion was attempted to force
  // out-of-order microtask resolution but timed out in vitest's worker
  // runner. The reversed-input approach is the deterministic proxy.
  it('reversed-input pendingBatches → results sorted ascending by batchIndex', async () => {
    const manifestsAscending = Array.from({ length: 5 }, (_, i) =>
      makeManifest({
        id: `batch-${i}`,
        batchIndex: i,
        recipientRangeStart: i * 3,
        recipientRangeEnd: i * 3 + 2,
        recipientCount: 3,
      }),
    );
    // Reverse the input order — pendingBatches=[4,3,2,1,0]
    const manifestsReversed = [...manifestsAscending].reverse();
    const deps = makeStubDeps({ manifests: manifestsAscending });

    const result = await dispatchAllPendingBatches(deps as never, {
      tenantId: tenant,
      broadcastContent,
      allRecipients: allRecipients.slice(0, 15),
      pendingBatches: manifestsReversed,
      concurrencyCap: 5,
    });

    // Despite reversed input, output is ascending [0,1,2,3,4] because
    // of the explicit sort. Without the sort, this would be reversed.
    expect(result.results.map((r) => r.batchIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(result.succeeded).toBe(5);
  });
});
