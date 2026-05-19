/**
 * Contract test — `POST /api/admin/renewals/tier-upgrades/[suggestionId]/accept`.
 *
 * Pins the error-mapping contract from `acceptTierUpgrade` Result.err
 * variants to HTTP status codes + observability emit. Specifically
 * covers:
 *
 *   - R4-C2 (Batch 5a): `case 'server_error':` emits
 *     `logger.error({errorId: 'F8.ACCEPT_TIER.SERVER_ERROR', ...})`
 *     so the SRE alert rule keyed on `F8.ACCEPT_TIER.*` actually fires
 *     when R3-S5's `deploy-skew:unhandled-gateway-arm:*` typed Result
 *     propagates to the route.
 *
 *   - R4-I4 (Batch 5b): outer `catch (e)` emits
 *     `errorId: 'F8.ACCEPT_TIER.UNEXPECTED'` so any uncaught throw
 *     (now blocked by R3-C3 pre-tx wrap, but defence-in-depth) is
 *     visible to alert routing.
 *
 * Mocks the auth context, env flags, tenant resolver, logger, and
 * `acceptTierUpgrade` so the handler runs without DB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const acceptTierUpgradeMock = vi.fn();
const f8FeatureFlag = { value: true };
const loggerErrorMock = vi.fn();

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === 'features') {
          return { ...target.features, f8Renewals: f8FeatureFlag.value };
        }
        return Reflect.get(target, prop);
      },
    }),
  };
});
vi.mock('@/lib/renewals-route-helpers', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/renewals-route-helpers')
  >('@/lib/renewals-route-helpers');
  return {
    ...actual,
    requireRenewalAdminContext: (...args: unknown[]) =>
      requireRenewalAdminContextMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
    debug: vi.fn(),
  },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    acceptTierUpgrade: (...args: unknown[]) => acceptTierUpgradeMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-accept-1',
  correlationId: 'corr-accept-1',
};

const SUGGESTION_ID = 'sugg-abc-1';

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/tier-upgrades/${SUGGESTION_ID}/accept`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ suggestionId: SUGGESTION_ID }) };
}

async function loadHandler() {
  const mod = await import(
    '@/app/api/admin/renewals/tier-upgrades/[suggestionId]/accept/route'
  );
  return mod.POST;
}

describe('contract: POST /api/admin/renewals/tier-upgrades/[suggestionId]/accept', () => {
  afterEach(() => {
    vi.clearAllMocks();
    f8FeatureFlag.value = true;
  });

  // R4-C2 (Batch 5a)
  it('500 server_error — emits logger.error with errorId F8.ACCEPT_TIER.SERVER_ERROR and the typed message', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    acceptTierUpgradeMock.mockResolvedValueOnce(
      err({
        kind: 'server_error' as const,
        message: 'deploy-skew:unhandled-gateway-arm:weird_gateway_arm',
      }),
    );

    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');

    // The alert-routing emit fires BEFORE the 500 returns.
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [structured, message] = loggerErrorMock.mock.calls[0]!;
    expect(structured.errorId).toBe('F8.ACCEPT_TIER.SERVER_ERROR');
    expect(structured.message).toBe(
      'deploy-skew:unhandled-gateway-arm:weird_gateway_arm',
    );
    expect(structured.correlationId).toBe('corr-accept-1');
    expect(structured.suggestionId).toBe(SUGGESTION_ID);
    expect(message).toBe('admin.renewals.tier-upgrades.accept_server_error');
  });

  // Sanity check: 503 when feature flag is off — does NOT emit
  // server_error log.
  it('503 feature_disabled — no logger.error', async () => {
    f8FeatureFlag.value = false;
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('feature_disabled');
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  // R4-I4 (Batch 5b) — outer catch emits errorId.
  it('500 uncaught throw — outer catch emits errorId F8.ACCEPT_TIER.UNEXPECTED', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    acceptTierUpgradeMock.mockRejectedValueOnce(
      new Error('simulated async-arm regression — defence-in-depth probe'),
    );

    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());

    expect(res.status).toBe(500);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [structured, message] = loggerErrorMock.mock.calls[0]!;
    expect(structured.errorId).toBe('F8.ACCEPT_TIER.UNEXPECTED');
    expect(structured.correlationId).toBe('corr-accept-1');
    expect(structured.suggestionId).toBe(SUGGESTION_ID);
    expect(message).toBe('admin.renewals.tier-upgrades.accept_unexpected_error');
  });
});
