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
import { err, ok } from '@/lib/result';

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
  // Round 2 (tests M-3): the success branch builds the BroadcastContent,
  // which reads the from address; without it the route threw before the
  // dispatcher — exactly the unreachable loop the PIN below exists to close.
  broadcasts: { fromEmail: 'noreply@swecham-fixture.com' },
  isDevelopment: false,
};

vi.mock('@/lib/env', () => ({
  env: envMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { logger } from '@/lib/logger';
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
// /code-review 2026-09-07 (finding #3) — the per-tick memo wrapper. The spy
// returns a MARKER so the resolver's deps can be checked for the wrapper
// rather than the raw bridge, and its call count proves once-per-TICK
// rather than once-per-row.
const makeTickMemoMock = vi.fn((bridge: unknown) => ({ kind: 'tick-memoized', inner: bridge }));
vi.mock('@/modules/broadcasts', async () => ({
  asBroadcastId: (raw: string) => raw,
  dispatchAllPendingBatches: (...args: unknown[]) => dispatchAllPendingBatchesMock(...args),
  // Pure Domain — the real one, so the boundary refusal is exercised.
  recipientSegmentFromPersisted: (
    await vi.importActual<typeof import('@/modules/broadcasts/domain/recipient-segment')>(
      '@/modules/broadcasts/domain/recipient-segment',
    )
  ).recipientSegmentFromPersisted,
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
  makeTickMemoizedMembersBridge: (bridge: unknown) => makeTickMemoMock(bridge),
  noOpAdvisoryLock: { kind: 'lock-stub' },
  resendBroadcastsGateway: { kind: 'gateway-stub' },
  resolveSegmentRecipients: (...args: unknown[]) => resolveSegmentRecipientsMock(...args),
  currentAudienceMode: () => 'all_contacts',
  // CONFIGURED, not the per-tick clamp — this route dispatches batches of an
  // audience that was split BECAUSE it exceeds one tick (T095, 2026-09-08).
  // 50,000 is a FORWARDING fixture: the composition root cannot return it for
  // `currentAudienceCeiling` any more, and what this file pins is pass-through.
  configuredAudienceCeiling: () => 50_000,
  currentAudienceCeiling: () => 800,
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
const SECOND_ID = '11111111-1111-4111-8111-222222222222';

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

  // /code-review 2026-09-07 (finding #3) — `dispatch-scheduled` has wrapped its
  // bridge in the per-tick memo since R6; this cron never did, so N rows on
  // one segment each re-walked the identical audience — and after 108 PR-C
  // that walk is a full 1:N keyset paginate plus an opted-out aggregate. TWO
  // rows, because with one row "wrapped once per tick" and "wrapped once per
  // row" are the same number.
  it('the tick memo wraps the bridge ONCE per tick, and the resolver gets the wrapper — not the raw bridge', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }, { broadcast_id: SECOND_ID }] }),
    );
    findByIdMock.mockResolvedValue({
      broadcastId: BROADCAST_ID,
      requestedByMemberId: 'm-requester',
      segmentType: 'all_members',
      segmentParams: null,
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

    expect(resolveSegmentRecipientsMock).toHaveBeenCalledTimes(2);
    expect(makeTickMemoMock).toHaveBeenCalledTimes(1);
    expect(makeTickMemoMock).toHaveBeenCalledWith({ kind: 'members-bridge-stub' });
    for (const call of resolveSegmentRecipientsMock.mock.calls) {
      const [deps] = call as [Record<string, unknown>];
      expect(deps['membersBridge']).toEqual({
        kind: 'tick-memoized',
        inner: { kind: 'members-bridge-stub' },
      });
    }
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

  // Review 2026-09-07 round 2 (tests M-3) — the per-row loop was reached on
  // the `!resolved.ok` branch only; a route handing the dispatcher `[]`
  // shipped green. PIN: the resolved addresses reach the dispatcher.
  it('PIN — a successful resolve hands the dispatcher exactly the resolved recipients', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({
        execute: async () => [{ broadcast_id: BROADCAST_ID }],
      }),
    );
    findByIdMock.mockResolvedValue({
      broadcastId: BROADCAST_ID,
      requestedByMemberId: 'm-requester',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      subject: 'S',
      bodyHtml: '<p>b</p>',
      fromName: 'F',
      replyToEmail: 'r@example.com',
      status: 'sending',
    });
    findPendingByBroadcastMock.mockResolvedValue([{ batchId: 'b-1', status: 'pending' }]);
    resolveSegmentRecipientsMock.mockResolvedValue(
      ok({ recipients: ['a@example.com', 'b@example.com'], orphans: [], droppedByPreference: 0, estimatedCount: 2 }),
    );
    dispatchAllPendingBatchesMock.mockResolvedValue({ dispatched: 1, failed: 0, skipped: 0 });

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-batches/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; errors: number; broadcastsDispatched: number };
    expect(body, JSON.stringify(vi.mocked(logger.error).mock.calls)).toMatchObject({ processed: 1, errors: 0 });
    expect(dispatchAllPendingBatchesMock).toHaveBeenCalledTimes(1);
    const serialised = JSON.stringify(dispatchAllPendingBatchesMock.mock.calls[0]);
    expect(serialised).toContain('a@example.com');
    expect(serialised).toContain('b@example.com');
    expect(dispatchResolveFailedTotalSpy).not.toHaveBeenCalled();
  });

  // Review 2026-09-07 round 2 (C2) — a tier row with no codes is a permanent
  // data defect. It must never reach the resolver as `{ tier, [] }` (which
  // read EVERY member on the flag-OFF leg), and it must not be counted as a
  // transient resolve failure (which would page on-call for a retry that can
  // never succeed).
  it('a tier row with no codes is refused BEFORE the resolver — errors++, not the transient counter', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({
        execute: async () => [{ broadcast_id: BROADCAST_ID }],
      }),
    );
    findByIdMock.mockResolvedValue({
      broadcastId: BROADCAST_ID,
      requestedByMemberId: 'm-requester',
      segmentType: 'tier',
      segmentParams: null,
      customRecipientEmails: null,
      status: 'sending',
    });
    findPendingByBroadcastMock.mockResolvedValue([{ batchId: 'b-1', status: 'pending' }]);

    const { POST } = await import('@/app/api/cron/broadcasts/dispatch-batches/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; errors: number; broadcastsDispatched: number };
    expect(body.processed).toBe(1);
    expect(body.errors).toBe(1);
    expect(body.broadcastsDispatched).toBe(0);

    expect(resolveSegmentRecipientsMock).not.toHaveBeenCalled();
    expect(dispatchResolveFailedTotalSpy).not.toHaveBeenCalled();
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });
});
