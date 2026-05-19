/**
 * Phase 3F.5 (2026-05-19) — Contract test for `dispatchBroadcastBatch`
 * use case (T045). Closes coverage gap pr-test-analyzer Finding 1:
 * the use case touches money (Resend API) + email side effects with
 * zero direct test coverage prior to this commit.
 *
 * Covers (a) happy path → manifest 'pending' → 'sending' + gateway
 * sequence executed in order + providerAudienceId persisted + audit
 * `broadcast_send_started` emitted; (b) gateway throws → manifest
 * transitions to 'failed' with failureReason + audit emitted;
 * (c) recipient slice length mismatch → server_error WITHOUT any
 * gateway call (defence-in-depth against wrong-recipients-to-wrong-
 * batch leak); (d) persist-after-send failure → ok return with
 * `broadcast_resend_resource_missing` audit (forensic backfill trail).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asIdempotencyKey } from '@/modules/broadcasts/domain/value-objects/idempotency-key';
import { dispatchBroadcastBatch } from '@/modules/broadcasts/application/use-cases/dispatch-broadcast-batch';
import type { BatchManifest } from '@/modules/broadcasts/application/ports/batch-manifests-port';
import type { TenantSlug } from '@/modules/tenants';

// Phase 3F.11.10 (Round 3 test-analyzer Gap 1) — mock the pino logger
// so audit-throw cases can verify `logger.error` was called with the
// canonical log-key tag. Without these assertions, a future regression
// that drops the `logger.error(...)` call inside a C4 audit-throw
// catch (silent log loss) would ship green — the use case would still
// return `ok` but ops would lose the forensic signal.
const loggerErrorSpy = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: {
    error: (...args: unknown[]) => loggerErrorSpy(...args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(() => {
  loggerErrorSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

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
  subject: 'Test subject',
  bodyHtml: '<p>body</p>',
  fromName: 'Test From',
  fromEmail: 'from@example.com',
  replyToEmail: 'reply@example.com',
  tenantDisplayName: 'Test Tenant',
  locale: 'en' as const,
};

const allRecipients = [
  { emailLower: 'a@example.com' },
  { emailLower: 'b@example.com' },
  { emailLower: 'c@example.com' },
];

interface StubDeps {
  readonly emits: Array<{ eventType: string; payload?: unknown }>;
  readonly statusUpdates: Array<{ status: string; providerBroadcastId?: string }>;
  readonly gatewayCalls: string[];
  readonly deps: unknown;
}

function makeStubDeps(opts: {
  manifest?: BatchManifest;
  gatewayThrowsAt?: 'createAudience' | 'addContactsToAudience' | 'createBroadcast' | 'sendBroadcast';
  persistFails?: boolean;
  /**
   * Phase 3F.11.1 (C4 — Round 2 fix) — if set, audit emits matching
   * the given event types throw. Used to verify the use case still
   * returns `ok` on success-path audit failure (Resend already sent).
   */
  auditThrowsForEvents?: ReadonlySet<string>;
}): StubDeps {
  const manifest = opts.manifest ?? makeManifest();
  const emits: Array<{ eventType: string; payload?: unknown }> = [];
  const statusUpdates: Array<{ status: string; providerBroadcastId?: string }> = [];
  const gatewayCalls: string[] = [];

  return {
    emits,
    statusUpdates,
    gatewayCalls,
    deps: {
      batchManifests: {
        async findByBroadcast() {
          return [manifest];
        },
        async updateStatus(_t: unknown, _id: unknown, update: { status: string; providerBroadcastId?: string }) {
          statusUpdates.push(update);
          if (opts.persistFails && update.providerBroadcastId !== undefined) {
            return { ok: false, error: { kind: 'storage_error' as const, detail: 'simulated' } };
          }
          return { ok: true, value: manifest };
        },
      },
      gateway: {
        async createAudience() {
          gatewayCalls.push('createAudience');
          if (opts.gatewayThrowsAt === 'createAudience') throw new Error('createAudience-boom');
          return { audienceId: 'aud-123' };
        },
        async addContactsToAudience() {
          gatewayCalls.push('addContactsToAudience');
          if (opts.gatewayThrowsAt === 'addContactsToAudience') throw new Error('addContacts-boom');
        },
        async createBroadcast() {
          gatewayCalls.push('createBroadcast');
          if (opts.gatewayThrowsAt === 'createBroadcast') throw new Error('createBroadcast-boom');
          return { broadcastId: 'resend-bid-1' };
        },
        async sendBroadcast() {
          gatewayCalls.push('sendBroadcast');
          if (opts.gatewayThrowsAt === 'sendBroadcast') throw new Error('sendBroadcast-boom');
        },
      },
      advisoryLock: {
        async acquire() {
          return { acquired: true };
        },
      },
      audit: {
        async emit(_tx: unknown, e: { eventType: string; payload?: unknown }) {
          if (opts.auditThrowsForEvents?.has(e.eventType)) {
            throw new Error(`audit-emit-boom-${e.eventType}`);
          }
          emits.push(e);
        },
      },
      clock: { now: () => new Date('2026-06-15T05:00:00Z') },
    },
  };
}

describe('dispatchBroadcastBatch contract (Phase 3F.5)', () => {
  it('happy path → gateway sequence executed + manifest persisted + send_started audit', async () => {
    const { deps, emits, statusUpdates, gatewayCalls } = makeStubDeps({});

    const result = await dispatchBroadcastBatch(deps as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-1',
      allRecipients,
      broadcastContent,
    });

    expect(result.ok).toBe(true);
    expect(gatewayCalls).toEqual([
      'createAudience',
      'addContactsToAudience',
      'createBroadcast',
      'sendBroadcast',
    ]);
    // 1st updateStatus = pending→sending; 2nd = persist providerBroadcastId.
    expect(statusUpdates).toHaveLength(2);
    expect(statusUpdates[0]?.status).toBe('sending');
    expect(statusUpdates[1]?.providerBroadcastId).toBe('resend-bid-1');
    expect(emits.some((e) => e.eventType === 'broadcast_send_started')).toBe(true);
  });

  // Phase 3F.11.5 (Round 2 G-2 closure) — parametrised per-stage
  // gateway failures. Pre-fix the test only exercised `createBroadcast`
  // throwing; a refactor that misroutes the `gatewayStage` variable
  // in the catch block (e.g., always reports `createAudience`) would
  // have shipped green. Now all 4 stages are covered.
  it.each([
    ['createAudience', ['sending', 'failed']] as const,
    ['addContactsToAudience', ['sending', 'failed']] as const,
    ['createBroadcast', ['sending', 'failed']] as const,
    ['sendBroadcast', ['sending', 'failed']] as const,
  ])('gateway throws at %s → GATEWAY_ERROR with matching stage + failed_to_dispatch audit', async (stage, expectedStatuses) => {
    const { deps, emits, statusUpdates } = makeStubDeps({
      gatewayThrowsAt: stage,
    });

    const result = await dispatchBroadcastBatch(deps as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-1',
      allRecipients,
      broadcastContent,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('GATEWAY_ERROR');
    expect((result.error as { stage: string }).stage).toBe(stage);

    expect(statusUpdates.map((s) => s.status)).toEqual(expectedStatuses);
    expect(emits.some((e) => e.eventType === 'broadcast_failed_to_dispatch')).toBe(true);
  });

  it('recipient slice length mismatch → server_error WITHOUT gateway call', async () => {
    // manifest declares recipientCount=10 but allRecipients only has 3
    const manifest = makeManifest({ recipientCount: 10, recipientRangeEnd: 9 });
    const { deps, gatewayCalls } = makeStubDeps({ manifest });

    const result = await dispatchBroadcastBatch(deps as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-1',
      allRecipients, // only 3 recipients — slice length 3 ≠ manifest.recipientCount 10
      broadcastContent,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe(
      'dispatch_broadcast_batch.server_error',
    );
    // Critical: NO gateway calls — the recipient-slice guard fires before any Resend interaction
    expect(gatewayCalls).toEqual([]);
  });

  it('persist providerBroadcastId fails after gateway sent → forensic audit emitted, but ok returned', async () => {
    const { deps, emits } = makeStubDeps({ persistFails: true });

    const result = await dispatchBroadcastBatch(deps as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-1',
      allRecipients,
      broadcastContent,
    });

    // Send already happened externally — use case returns ok with the
    // provider audience id. But forensic audit is emitted so on-call
    // can backfill the manifest from Resend dashboard.
    expect(result.ok).toBe(true);
    expect(
      emits.some((e) => e.eventType === 'broadcast_resend_resource_missing'),
    ).toBe(true);
  });

  // Phase 3F.11.1 (C4 — Round 2 fix): success-path audit emit throws
  // → use case still returns ok (Resend already delivered). Without
  // the try/catch wrap, an audit-port DB-down condition would synthesise
  // `failed` outcomes in batch-dispatcher even though emails went out.
  it('broadcast_send_started audit throws → use case still returns ok + logger.error called with canonical key', async () => {
    const { deps } = makeStubDeps({
      auditThrowsForEvents: new Set(['broadcast_send_started']),
    });

    const result = await dispatchBroadcastBatch(deps as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-1',
      allRecipients,
      broadcastContent,
    });

    // Use case returns ok despite audit throw — caller (batch-dispatcher)
    // must not synthesise `failed` outcome for a successful Resend send.
    expect(result.ok).toBe(true);

    // Phase 3F.11.10 (Round 3 Gap 1) — assert ops feed receives the
    // forensic signal. A regression that drops the logger.error call
    // would ship green without this assertion.
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tenantId: 'test-tenant',
        batchManifestId: 'batch-id-1',
      }),
      'broadcasts.dispatch.send_started_audit_emit_failed',
    );
  });

  it('broadcast_resend_resource_missing audit throws on persistFails path → use case still returns ok + logger.error called', async () => {
    const { deps } = makeStubDeps({
      persistFails: true,
      auditThrowsForEvents: new Set(['broadcast_resend_resource_missing']),
    });

    const result = await dispatchBroadcastBatch(deps as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-1',
      allRecipients,
      broadcastContent,
    });

    // Forensic audit failed BUT the send was real — use case returns
    // ok so the worker pool records a sent_to_resend outcome (matches
    // production reality).
    expect(result.ok).toBe(true);

    // Phase 3F.11.10 (Round 3 Gap 1) — same assertion for the
    // resource-missing audit-throw path. Distinct log-key tag so ops
    // can distinguish the two failure modes in pino feed.
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tenantId: 'test-tenant',
        batchManifestId: 'batch-id-1',
      }),
      'broadcasts.dispatch.resend_resource_missing_audit_emit_failed',
    );
  });

  // Phase 3F.11.4 (Round 2 test gap closures) — 3 error branches that
  // had zero coverage prior to this commit. Per Constitution Principle
  // II 80% branch threshold on Application use cases, these branches
  // SHOULD have been tested at T045 ship.
  it('manifest not in findByBroadcast list → BATCH_NOT_FOUND', async () => {
    const { deps, gatewayCalls } = makeStubDeps({});

    const result = await dispatchBroadcastBatch(deps as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-DOES-NOT-EXIST',
      allRecipients,
      broadcastContent,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('BATCH_NOT_FOUND');
    // Pre-condition fail → no gateway calls
    expect(gatewayCalls).toEqual([]);
  });

  it('manifest.status !== pending → INVALID_STATE_TRANSITION', async () => {
    const sendingManifest = makeManifest({ status: 'sending' });
    const { deps, gatewayCalls } = makeStubDeps({ manifest: sendingManifest });

    const result = await dispatchBroadcastBatch(deps as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-1',
      allRecipients,
      broadcastContent,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('INVALID_STATE_TRANSITION');
    expect((result.error as { currentStatus: string }).currentStatus).toBe('sending');
    expect((result.error as { expected: string }).expected).toBe('pending');
    expect(gatewayCalls).toEqual([]);
  });

  it('advisoryLock.acquire returns {acquired: false} → ALREADY_DISPATCHING_IN_PROGRESS', async () => {
    const baseDeps = makeStubDeps({});
    // Override advisoryLock.acquire to reject acquisition
    const depsWithRejectedLock = {
      ...(baseDeps.deps as Record<string, unknown>),
      advisoryLock: {
        async acquire() {
          return { acquired: false as const };
        },
      },
    };

    const result = await dispatchBroadcastBatch(depsWithRejectedLock as never, {
      tenantId: tenant,
      batchManifestId: 'batch-id-1',
      allRecipients,
      broadcastContent,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('ALREADY_DISPATCHING_IN_PROGRESS');
    // Lock not acquired → no gateway calls
    expect(baseDeps.gatewayCalls).toEqual([]);
  });
});
