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
 *
 * Per-broadcast dispatch behaviour is covered by the use-case +
 * service contract tests (`dispatch-broadcast-batch.test.ts` +
 * `batch-dispatcher.test.ts`). This test only locks the route shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const runInTenantMock = vi.fn();
const isF71aUs1EnabledMock = vi.fn();
const f71aUs1DisabledReasonMock = vi.fn();

const envMock = {
  cron: { secret: 'test-cron-secret' },
  tenant: { slug: 'test-tenant', timezone: 'Asia/Bangkok' },
  features: {
    f7Broadcasts: true,
    f71aBroadcastAdvance: true,
  },
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
vi.mock('@/modules/broadcasts', () => ({
  asBroadcastId: (raw: string) => raw,
  resolveSegmentRecipients: vi.fn().mockResolvedValue([]),
  tenantDefaultLocaleFor: () => 'en',
  isF71aUs1Enabled: () => isF71aUs1EnabledMock(),
  f71aUs1DisabledReason: () => f71aUs1DisabledReasonMock(),
}));
vi.mock('@/modules/broadcasts/domain/value-objects/email-lower', () => ({
  unsafeBrandEmailLower: (e: string) => e,
}));
vi.mock('@/modules/broadcasts/infrastructure/drizzle-batch-manifests-repo', () => ({
  makeDrizzleBatchManifestsRepo: vi.fn(),
}));
vi.mock('@/modules/broadcasts/infrastructure/db/drizzle-broadcasts-repo', () => ({
  makeDrizzleBroadcastsRepo: vi.fn(),
}));
vi.mock('@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo', () => ({
  makeDrizzleMarketingUnsubscribesRepo: vi.fn(),
}));
vi.mock('@/modules/broadcasts/infrastructure/members-bridge', () => ({
  membersBridge: {},
}));
vi.mock('@/modules/broadcasts/infrastructure/event-attendees-stub', () => ({
  eventAttendeesStub: {},
}));
vi.mock('@/modules/broadcasts/infrastructure/audit-adapter', () => ({
  f7AuditAdapter: {},
}));
vi.mock('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway', () => ({
  resendBroadcastsGateway: {},
}));
vi.mock('@/modules/broadcasts/infrastructure/noop-advisory-lock', () => ({
  noOpAdvisoryLock: {},
}));
vi.mock('@/modules/broadcasts/infrastructure/broadcasts-deps', () => ({
  systemClock: { now: () => new Date('2026-06-15T05:00:00Z') },
}));
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
vi.mock('@/modules/broadcasts/application/services/batch-dispatcher', () => ({
  dispatchAllPendingBatches: (...args: unknown[]) =>
    dispatchAllPendingBatchesMock(...args),
}));

function makeRequest(opts: { auth?: string }): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) {
    headers['authorization'] = opts.auth;
  }
  return new NextRequest(
    'http://localhost/api/cron/broadcasts/dispatch-batches',
    {
      method: 'POST',
      headers,
    },
  );
}

beforeEach(() => {
  isF71aUs1EnabledMock.mockReturnValue(true);
  f71aUs1DisabledReasonMock.mockReturnValue(null);
  runInTenantMock.mockReset();
  dispatchAllPendingBatchesMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cron dispatch-batches — wire contract (Phase 3F.11.5 / Finding 9)', () => {
  it('missing Authorization → 401 unauthorized', async () => {
    const { POST } = await import(
      '@/app/api/cron/broadcasts/dispatch-batches/route'
    );
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthorized');
    // No DB query attempted on rejected auth.
    expect(runInTenantMock).not.toHaveBeenCalled();
    // Phase 3F.11.10 (Round 3 MED-2) — also verify the orchestrator
    // service was NEVER reached. Without this a regression that moves
    // the auth check below dispatch-fan-out would ship green.
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });

  it('wrong Bearer token → 401 unauthorized', async () => {
    const { POST } = await import(
      '@/app/api/cron/broadcasts/dispatch-batches/route'
    );
    const res = await POST(makeRequest({ auth: 'Bearer wrong-secret' }));
    expect(res.status).toBe(401);
    expect(runInTenantMock).not.toHaveBeenCalled();
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });

  it('kill-switch off → 200 + {skipped:true, reason:feature_disabled:*}', async () => {
    // T061 dark-launch — returns 200 to prevent cron-job.org retry-storm.
    isF71aUs1EnabledMock.mockReturnValueOnce(false);
    f71aUs1DisabledReasonMock.mockReturnValueOnce('f71a_master');
    const { POST } = await import(
      '@/app/api/cron/broadcasts/dispatch-batches/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skipped?: boolean;
      reason?: string;
    };
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('feature_disabled:f71a_master');
    expect(runInTenantMock).not.toHaveBeenCalled();
    // Phase 3F.11.10 (Round 3 MED-2) — orchestrator NOT invoked when
    // kill-switch fires. Defends against a regression that moves the
    // feature flag check below the eligible scan + dispatch.
    expect(dispatchAllPendingBatchesMock).not.toHaveBeenCalled();
  });

  it('valid bearer + zero eligible rows → 200 + processed:0', async () => {
    // Mock runInTenant: first call (eligible scan) returns empty array.
    runInTenantMock.mockImplementation(async (_ctx, fn) =>
      fn({
        execute: async () => [],
      }),
    );
    const { POST } = await import(
      '@/app/api/cron/broadcasts/dispatch-batches/route'
    );
    const res = await POST(
      makeRequest({ auth: 'Bearer test-cron-secret' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number | boolean>;
    expect(body.processed).toBe(0);
  });
});
