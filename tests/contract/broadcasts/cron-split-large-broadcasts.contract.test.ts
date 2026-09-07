/**
 * 108 PR-C review (2026-09-07, tests HIGH) — contract test for the
 * split-large-broadcasts cron route. The route had NO test of any kind while
 * PR-C rewired its resolver call (audience mode + ceiling from the
 * composition root, `requestingMemberId` in place of the deleted
 * primary-email lookup) — hardcode `audienceMode: 'primary_only'` here and
 * every > 10,000 audience would have been batched from the narrow leg while
 * compose showed the wide count, with no failing test.
 *
 * Wire-contract surfaces (the `dispatch-batches` shell-pattern):
 *   - missing / wrong Authorization                → 401 unauthorized
 *   - kill-switch off (isF71aUs1Enabled=false)     → 200 + skipped:true
 *   - valid bearer + zero eligible rows            → 200 + processed:0
 *   - one eligible row → the resolver receives the composition root's mode +
 *     ceiling, phase `dispatch` and the broadcast's `requestedByMemberId`; a
 *     `resolve.server_error` counts on `dispatchResolveFailedTotal`, the row
 *     is left `approved` (no split, no transition) and the tick continues.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const runInTenantMock = vi.fn();
const isF71aUs1EnabledMock = vi.fn();
const f71aUs1DisabledReasonMock = vi.fn();
const resolveSegmentRecipientsMock = vi.fn();
const findByIdMock = vi.fn();
const splitBroadcastIntoBatchesMock = vi.fn();
const dispatchResolveFailedTotalSpy = vi.fn();

const envMock = {
  cron: { secret: 'test-cron-secret' },
  features: { f7Broadcasts: true, f71aBroadcastAdvanced: true, f71aUs1Pagination: true },
  isDevelopment: false,
};

vi.mock('@/lib/env', () => ({ env: envMock }));
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
// Every key the route imports from the barrel (a missing key throws on
// access — the stale-stub class this file exists to close).
// /code-review 2026-09-07 (finding #3) — the per-tick memo wrapper. The spy
// returns a MARKER so the resolver's deps can be checked for the wrapper
// rather than the raw bridge, and its call count proves once-per-TICK
// rather than once-per-row.
const makeTickMemoMock = vi.fn((bridge: unknown) => ({ kind: 'tick-memoized', inner: bridge }));
vi.mock('@/modules/broadcasts', async () => ({
  asBroadcastId: (raw: string) => raw,
  BroadcastConcurrentMutationError: class BroadcastConcurrentMutationError extends Error {},
  // Pure Domain — the real one, so the boundary refusal is exercised.
  recipientSegmentFromPersisted: (
    await vi.importActual<typeof import('@/modules/broadcasts/domain/recipient-segment')>(
      '@/modules/broadcasts/domain/recipient-segment',
    )
  ).recipientSegmentFromPersisted,
  eventAttendeesBridge: { kind: 'event-attendees-stub' },
  f71aUs1DisabledReason: () => f71aUs1DisabledReasonMock(),
  isF71aUs1Enabled: () => isF71aUs1EnabledMock(),
  makeDrizzleBroadcastsRepo: () => ({
    findById: (...args: unknown[]) => findByIdMock(...args),
    // Round 2 (tests M-3): the success branch transitions `approved → sending`
    // inside a tx; the stub lets that path run so the split is observable.
    withTx: async (fn: (tx: unknown) => unknown) => fn({ tx: 'fake' }),
    applyTransition: async () => undefined,
  }),
  makeDrizzleMarketingUnsubscribesRepo: () => ({ kind: 'unsubscribes-stub' }),
  makeSplitBroadcastIntoBatchesDeps: () => ({ kind: 'split-deps-stub' }),
  membersBridge: { kind: 'members-bridge-stub' },
  makeTickMemoizedMembersBridge: (bridge: unknown) => makeTickMemoMock(bridge),
  resolveSegmentRecipients: (...args: unknown[]) => resolveSegmentRecipientsMock(...args),
  currentAudienceMode: () => 'all_contacts',
  currentAudienceCeiling: () => 50_000,
  SPLIT_THRESHOLD_RECIPIENTS: 10_000,
  splitBroadcastIntoBatches: (...args: unknown[]) => splitBroadcastIntoBatchesMock(...args),
}));
vi.mock('@/modules/broadcasts/domain/value-objects/email-lower', () => ({
  unsafeBrandEmailLower: (e: string) => e,
}));

function makeRequest(opts: { auth?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers['authorization'] = opts.auth;
  return new NextRequest('http://localhost/api/cron/broadcasts/split-large-broadcasts', {
    method: 'POST',
    headers,
  });
}

const BROADCAST_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_ID = '22222222-2222-4222-8222-333333333333';

beforeEach(() => {
  isF71aUs1EnabledMock.mockReturnValue(true);
  f71aUs1DisabledReasonMock.mockReturnValue(null);
  runInTenantMock.mockReset();
  resolveSegmentRecipientsMock.mockReset();
  findByIdMock.mockReset();
  splitBroadcastIntoBatchesMock.mockReset();
  dispatchResolveFailedTotalSpy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron split-large-broadcasts — wire contract (108 PR-C review)', () => {
  // Review 2026-09-07 round 2 (perf HIGH-2) — both sibling resolver crons
  // export maxDuration = 300; this one did not, and PR-C made its per-row
  // cost a full 1:N audience walk ×10. A platform kill runs no `catch`, so
  // the resolve-failed counter this branch added would never fire.
  it('exports the same 300 s function budget as its two sibling resolver crons', async () => {
    const mod = await import('@/app/api/cron/broadcasts/split-large-broadcasts/route');
    expect(mod.maxDuration).toBe(300);
    expect(mod.GET).toBe(mod.POST);
  });

  it('missing Authorization → 401; wrong Bearer → 401; no query either way', async () => {
    const { POST } = await import('@/app/api/cron/broadcasts/split-large-broadcasts/route');
    expect((await POST(makeRequest({}))).status).toBe(401);
    expect((await POST(makeRequest({ auth: 'Bearer wrong-secret' }))).status).toBe(401);
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(splitBroadcastIntoBatchesMock).not.toHaveBeenCalled();
  });

  it('kill-switch off → 200 + {skipped:true, reason:feature_disabled:*}', async () => {
    isF71aUs1EnabledMock.mockReturnValue(false);
    f71aUs1DisabledReasonMock.mockReturnValue('f71a_us1_pagination');
    const { POST } = await import('@/app/api/cron/broadcasts/split-large-broadcasts/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: 'feature_disabled:f71a_us1_pagination' });
    expect(runInTenantMock).not.toHaveBeenCalled();
  });

  it('valid bearer + zero eligible rows → 200 + processed:0', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) => fn({ execute: async () => [] }));
    const { POST } = await import('@/app/api/cron/broadcasts/split-large-broadcasts/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 0, split: 0, skipped: 0, errors: 0 });
    expect(splitBroadcastIntoBatchesMock).not.toHaveBeenCalled();
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
      status: 'approved',
      estimatedRecipientCount: 12_000,
    });
    resolveSegmentRecipientsMock.mockResolvedValue(
      err({ kind: 'resolve.server_error', message: 'members-bridge.getContactsBySegment: repo.unexpected' }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/split-large-broadcasts/route');
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

  it('one eligible row: the resolver gets the composition root mode/ceiling, phase dispatch and the requesting member; a failed resolve counts, leaves the row, continues', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    findByIdMock.mockResolvedValue({
      broadcastId: BROADCAST_ID,
      requestedByMemberId: 'm-requester',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      status: 'approved',
      estimatedRecipientCount: 12_000,
    });
    resolveSegmentRecipientsMock.mockResolvedValue(
      err({ kind: 'resolve.server_error', message: 'members-bridge.getContactsBySegment: repo.unexpected' }),
    );

    const { POST } = await import('@/app/api/cron/broadcasts/split-large-broadcasts/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; split: number; errors: number };
    expect(body.processed).toBe(1);
    expect(body.split).toBe(0);
    expect(body.errors).toBe(1);

    expect(resolveSegmentRecipientsMock).toHaveBeenCalledTimes(1);
    const [deps, input] = resolveSegmentRecipientsMock.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(deps).toMatchObject({ audienceMode: 'all_contacts', audienceCeiling: 50_000 });
    expect(deps['tenant']).toEqual({ slug: 'test-tenant' });
    expect(input).toEqual({
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: 'm-requester',
      customRecipients: null,
    });

    // Review errors HIGH-4 — counted, not just logged; the split never ran,
    // so the row stays `approved` for the next tick.
    expect(dispatchResolveFailedTotalSpy).toHaveBeenCalledWith('test-tenant');
    expect(splitBroadcastIntoBatchesMock).not.toHaveBeenCalled();
  });

  // Review 2026-09-07 round 2 (tests M-3) — the success branch was never
  // reached. PINS: above the threshold the split runs with the resolved
  // count; at or below it the row is skipped and the split never runs.
  it('PIN — a resolve above SPLIT_THRESHOLD_RECIPIENTS splits; one at the threshold is skipped', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    findByIdMock.mockResolvedValue({
      broadcastId: BROADCAST_ID,
      requestedByMemberId: 'm-requester',
      segmentType: 'all_members',
      segmentParams: null,
      customRecipientEmails: null,
      status: 'approved',
      estimatedRecipientCount: 12_000,
    });
    const big = Array.from({ length: 10_001 }, (_, i) => `r${i}@example.com`);
    resolveSegmentRecipientsMock.mockResolvedValueOnce(
      ok({ recipients: big, orphans: [], droppedByPreference: 0, estimatedCount: big.length }),
    );
    splitBroadcastIntoBatchesMock.mockResolvedValueOnce(ok({ batchCount: 2 }));

    const { POST } = await import('@/app/api/cron/broadcasts/split-large-broadcasts/route');
    let res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    let body = (await res.json()) as { processed: number; split: number; skipped: number; errors: number };
    expect(body.split).toBe(1);
    expect(body.errors).toBe(0);
    expect(splitBroadcastIntoBatchesMock).toHaveBeenCalledTimes(1);
    // The split is told the RESOLVED count (its batch arithmetic), never the
    // stale `estimated_recipient_count` from submit time.
    expect(splitBroadcastIntoBatchesMock.mock.calls[0]?.[1]).toMatchObject({ resolvedRecipientCount: 10_001 });

    // At the threshold: not split, skipped.
    splitBroadcastIntoBatchesMock.mockClear();
    resolveSegmentRecipientsMock.mockResolvedValueOnce(
      ok({ recipients: big.slice(0, 10_000), orphans: [], droppedByPreference: 0, estimatedCount: 10_000 }),
    );
    res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    body = (await res.json()) as { processed: number; split: number; skipped: number; errors: number };
    expect(body.split).toBe(0);
    expect(body.skipped).toBe(1);
    expect(splitBroadcastIntoBatchesMock).not.toHaveBeenCalled();
  });

  // Review 2026-09-07 round 2 (C2) — see the sibling case in
  // cron-dispatch-batches: a tier row with no codes is refused at the
  // boundary, never resolved, never counted as transient.
  it('a tier row with no codes is refused BEFORE the resolver — errors++, not the transient counter', async () => {
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({ execute: async () => [{ broadcast_id: BROADCAST_ID }] }),
    );
    findByIdMock.mockResolvedValue({
      broadcastId: BROADCAST_ID,
      requestedByMemberId: 'm-requester',
      segmentType: 'tier',
      segmentParams: { tierCodes: [] },
      customRecipientEmails: null,
      status: 'approved',
      estimatedRecipientCount: 12_000,
    });

    const { POST } = await import('@/app/api/cron/broadcasts/split-large-broadcasts/route');
    const res = await POST(makeRequest({ auth: 'Bearer test-cron-secret' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; split: number; errors: number };
    expect(body.processed).toBe(1);
    expect(body.split).toBe(0);
    expect(body.errors).toBe(1);

    expect(resolveSegmentRecipientsMock).not.toHaveBeenCalled();
    expect(dispatchResolveFailedTotalSpy).not.toHaveBeenCalled();
    expect(splitBroadcastIntoBatchesMock).not.toHaveBeenCalled();
  });
});
