/**
 * 070 F8 item #18 contract test — POST `/api/admin/renewals/[cycleId]/reactivate`.
 *
 * Admin approves a `pending_admin_reactivation` cycle (FR-005b override).
 * Mirrors the `admin-cancel-route.test.ts` shape: mocks the use-case +
 * RBAC helper so HTTP status ↔ error-kind mapping is asserted in isolation.
 *
 * Coverage:
 *   - kill-switch 503
 *   - manager 403 (helper-forwarded rejection)
 *   - 200 happy path snake_case body
 *   - 400 invalid_body on malformed JSON
 *   - invalid_input 400 / cycle_not_found 404 / cycle_not_pending 409+current_status
 *   - server_error 500
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const adminReactivateLapsedCycleMock = vi.fn();
const f8FeatureFlag = { value: true };

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/renewals', async () => {
  const actual = await vi.importActual<typeof import('@/modules/renewals')>(
    '@/modules/renewals',
  );
  return {
    ...actual,
    adminReactivateLapsedCycle: (...args: unknown[]) =>
      adminReactivateLapsedCycleMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-react-1',
  correlationId: 'corr-react-1',
};

const VALID_UUID = '00000000-0000-0000-0000-0000000000d1';

function makeReq(body: string | null = '{}'): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/renewals/${VALID_UUID}/reactivate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ?? '',
    },
  );
}

function makeCtx() {
  return { params: Promise.resolve({ cycleId: VALID_UUID }) };
}

async function loadHandler() {
  const mod = await import(
    '@/app/api/admin/renewals/[cycleId]/reactivate/route'
  );
  return mod.POST;
}

describe('POST /api/admin/renewals/[cycleId]/reactivate — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('503 when feature flag off', { timeout: 30_000 }, async () => {
    f8FeatureFlag.value = false;
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(503);
    expect(adminReactivateLapsedCycleMock).not.toHaveBeenCalled();
  });

  it('passes through 403 from helper for manager', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: { code: 'forbidden' } }), {
        status: 403,
      }),
    });
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(403);
    expect(adminReactivateLapsedCycleMock).not.toHaveBeenCalled();
  });

  it('200 happy path with snake_case body', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminReactivateLapsedCycleMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'completed',
        closedReason: 'admin_reactivated',
        closedAt: '2026-06-14T10:00:00.000Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cycle_status).toBe('completed');
    expect(body.closed_reason).toBe('admin_reactivated');
    expect(body.closed_at).toBe('2026-06-14T10:00:00.000Z');
  });

  it('accepts an empty body (no JSON sent)', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminReactivateLapsedCycleMock.mockResolvedValueOnce(
      ok({
        cycleStatus: 'completed',
        closedReason: 'admin_reactivated',
        closedAt: '2026-06-14T10:00:00.000Z',
      }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(''), makeCtx());
    expect(res.status).toBe(200);
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
    expect(adminReactivateLapsedCycleMock).not.toHaveBeenCalled();
  });

  it('400 invalid_input from use-case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminReactivateLapsedCycleMock.mockResolvedValueOnce(
      err({ kind: 'invalid_input', message: 'invalid cycle id' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });

  it('404 cycle_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminReactivateLapsedCycleMock.mockResolvedValueOnce(
      err({ kind: 'cycle_not_found' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
  });

  it('409 cycle_not_pending with current_status payload', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminReactivateLapsedCycleMock.mockResolvedValueOnce(
      err({ kind: 'cycle_not_pending', currentStatus: 'completed' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('cycle_not_pending');
    expect(body.error.current_status).toBe('completed');
  });

  it('500 server_error', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminReactivateLapsedCycleMock.mockResolvedValueOnce(
      err({ kind: 'server_error', message: 'boom' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });

  it('500 on unexpected throw', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    adminReactivateLapsedCycleMock.mockRejectedValueOnce(
      new Error('db: connection lost'),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });
});
