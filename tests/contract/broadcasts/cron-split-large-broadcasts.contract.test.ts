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
import { err } from '@/lib/result';

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
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  BroadcastConcurrentMutationError: class BroadcastConcurrentMutationError extends Error {},
  eventAttendeesBridge: { kind: 'event-attendees-stub' },
  f71aUs1DisabledReason: () => f71aUs1DisabledReasonMock(),
  isF71aUs1Enabled: () => isF71aUs1EnabledMock(),
  makeDrizzleBroadcastsRepo: () => ({ findById: (...args: unknown[]) => findByIdMock(...args) }),
  makeDrizzleMarketingUnsubscribesRepo: () => ({ kind: 'unsubscribes-stub' }),
  makeSplitBroadcastIntoBatchesDeps: () => ({ kind: 'split-deps-stub' }),
  membersBridge: { kind: 'members-bridge-stub' },
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
});
