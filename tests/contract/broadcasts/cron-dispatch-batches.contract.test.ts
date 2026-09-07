/**
 * Phase 3F.11.5 (Round 2 Finding 9 closure) — Contract test for the
 * dispatch-batches cron route handler. Mirrors the
 * `cron-reconcile-stuck-sending.contract.test.ts` shell-pattern.
 *
 * Wire-contract surfaces:
 *   - missing Authorization header             → 401 unauthorized
 *   - wrong Bearer token                       → 401 unauthorized
 *   - kill-switch off (isF71aUs1Enabled=false) → 200 + skipped:true
 *   - valid bearer + zero eligible rows        → 200 + processed:0
 *   - valid bearer + one eligible row (108 PR-C review, tests HIGH) → the
 *     resolver receives the composition root's audience mode + ceiling, phase
 *     `dispatch`, and the broadcast's `requestedByMemberId`; a
 *     `resolve.server_error` counts on `dispatchResolveFailedTotal`, the tick
 *     continues (`errors: 1`) and nothing is dispatched.
 *
 * Review 2026-09-07: the previous barrel mock carried five keys and a
 * resolver stub answering `[]` — a shape the real resolver never returned —
 * so the per-broadcast loop was unreachable and both facts above were
 * unpinned (the route reads every dependency through the barrel, so the
 * deep-path mocks that used to sit here were dead). The factory now mirrors
 * the route's import list; a missing key fails loudly on first access.
 *
 * Per-batch dispatch behaviour is covered by the use-case + service contract
 * tests (`dispatch-broadcast-batch.test.ts` + `batch-dispatcher.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

const runInTenantMock = vi.fn();
const isF71aUs1EnabledMock = vi.fn();
const f71aUs1DisabledReasonMock = vi.fn();
const resolveSegmentRecipientsMock = vi.fn();
const findByIdMock = vi.fn();
const findPendingByBroadcastMock = vi.fn();
const dispatchResolveFailedTotalSpy = vi.fn();
// Phase 3F.11.10 (Round 3 MED-2) — capture dispatchAllPendingBatches
// invocations so kill-switch + auth-rejection paths can assert it was
// NOT called. Without this hoisted reference, a regression that moved
// the kill-switch check BELOW use-case dispatch would ship green.
const dispatchAllPendingBatchesMock = vi.fn().mockResolvedValue({
  totalBatches: 0,
  succeeded: 0,
  failed: 0,
  results: [],
  elapsedMs: 0,
});

const envMock = {
  cron: { secret: 'test-cron-secret' },
  features: { f7Broadcasts: true, f71aBroadcastAdvanced: true, f71aUs1Pagination: true },
  isDevelopment: false,
};

vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: (...args: unknown[]) => runInTenantMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));
vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      dispatchResolveFailedTotal: (...args: unknown[]) => dispatchResolveFailedTotalSpy(...args),
    },
  };
});
// Every key the route imports from the barrel — nothing the route does not
// read, nothing missing (a missing key throws on access instead of `undefined`).
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  dispatchAllPendingBatches: (...args: unknown[]) => dispatchAllPendingBatchesMock(...args),
  eventAttendeesBridge: { kind: 'event-attendees-stub' },
  f71aUs1DisabledReason: () => f71aUs1DisabledReasonMock(),
  f7AuditAdapter: { kind: 'audit-stub' },
  isF71aUs1Enabled: () => isF71aUs1EnabledMock(),
  makeDrizzleBatchManifestsRepo: () => ({
    findPendingByBroadcast: (...args: unknown[]) => findPendingByBroadcastMock(...args),
  }),
  makeDrizzleBroadcastsRepo: () => ({ findById: (...args: unknown[]) => findByIdMock(...args) }),
  makeDrizzleMarketingUnsubscribesRepo: () => ({ kind: 'unsubscribes-stub' }),
  membersBridge: { kind: 'members-bridge-stub' },
  noOpAdvisoryLock: { kind: 'lock-stub' },
  resendBroadcastsGateway: { kind: 'gateway-stub' },
  resolveSegmentRecipients: (...args: unknown[]) => resolveSegmentRecipientsMock(...args),
  currentAudienceMode: () => 'all_contacts',
  currentAudienceCeiling: () => 50_000,
  systemClock: { now: () => new Date('2026-09-07T00:00:00Z') },
  tenantDefaultLocaleFor: () => 'en',
}));
vi.mock('@/modules/broadcasts/domain/value-objects/email-lower', () => ({
  unsafeBrandEmailLower: (e: string) => e,
}));
vi.mock('@/modules/broadcasts/domain/policies/batch-concurrency-policy', () => ({
  DEFAULT_CONCURRENCY_CAP: 4,
  validateConcurrencyCap: (n: number) => n,
}));

function makeRequest(opts: { auth?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) {
    headers['authorization'] = opts.auth;
  }
  return new NextRequest('http://localhost/api/cron/broadcasts/dispatch-batches', {
    method: 'POST',
    headers,
  });
}

const BROADCAST_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  isF71aUs1EnabledMock.mockReturnValue(true);
  f71aUs1DisabledReasonMock.mockReturnValue(null);
  runInTenantMock.mockReset();
  resolveSegmentRecipientsMock.mockReset();
  findByIdMock.mockReset();
  findPendingByBroadcastMock.mockReset();
  dispatchResolveFailedTotalSpy.mockReset();
  dispatchAllPendingBatchesMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron dispatch-batches — wire contract (Phase 3F.11.5 / Finding 9)', () => {
  it('missing Authorization → 401 unauthorized', async () => {
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-batches/route');
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
    // No DB query attempted on rejected auth.
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });

  it('wrong Bearer token → 401 unauthorized', async () => {
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-batches/route');
    const res = await POST(makeRequest({ auth: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });

  it('kill-switch off → 200 + {skipped:true, reason:feature_disabled:*}', async () => {
    isF71aUs1EnabledMock.mockReturnValue(false);
    f71aUs1DisabledReasonMock.mockReturnValue('f71a_us1_pagination');
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-batches/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('feature_disabled:f71a_us1_pagination');
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });

  it('valid bearer + zero eligible rows → 200 + processed:0', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({
        execute: async () => [],
      }),
    );
    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-batches/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; broadcastsDispatched: number };
    expect(body.processed).toBe(0);
    expect(body.broadcastsDispatched).toBe(0);
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });

  it('one eligible row: the resolver gets the composition root mode/ceiling, phase dispatch and the requesting member; a failed resolve counts and continues', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({
        execute: async () => [{ broadcast_id: BROADCAST_ID }],
      }),
    );
    findByIdMock.mockResolvedValue({
      broadcastId: BROADCAST_ID,
      requestedByMemberId: 'm-requester',
      segmentType: 'tier',
      segmentParams: { tierCodes: ['corporate'] },
      customRecipientEmails: null,
      status: 'sending',
    });
    findPendingByBroadcastMock.mockResolvedValue([{ batchId: 'b-1', status: 'pending' }]);
    resolveSegmentRecipientsMock.mockResolvedValue(
      err({ kind: 'resolve.server_error', message: 'members-bridge.getContactsBySegment: repo.unexpected' }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-batches/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; errors: number; broadcastsDispatched: number };
    expect(body.processed).toBe(1);
    expect(body.errors).toBe(1);
    expect(body.broadcastsDispatched).toBe(0);

    // SC-004 at the third call site: the SAME mode + ceiling the count and
    // submit paths read, and the sender excluded by MEMBER id.
    expect(resolveSegmentRecipientsMock).toHaveBeenCalledTimes(1);
    const [deps, input] = resolveSegmentRecipientsMock.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(deps).toMatchObject({ audienceMode: 'all_contacts', audienceCeiling: 50_000 });
    expect(deps['tenant']).toEqual({ slug: 'test-tenant' });
    expect(input).toEqual({
      segment: { kind: 'tier', tierCodes: ['corporate'] },
      phase: 'dispatch',
      requestingMemberId: 'm-requester',
      customRecipients: null,
    });

    // Review errors HIGH-4 — the failure is counted, not just logged, and
    // the batches are left untouched for the next tick.
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledWith('test-tenant');
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });
});
