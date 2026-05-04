/**
 * F8 Phase 3 Wave H3 · T065 contract test — POST `/api/admin/renewals/[cycleId]/cancel`.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireRenewalAdminContextMock = vi.fn();
const cancelCycleMock = vi.fn();
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
    cancelCycle: (...args: unknown[]) => cancelCycleMock(...args),
    makeRenewalsDeps: () => ({}),
  };
});

const ADMIN_CTX = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-3',
  correlationId: 'corr-3',
};

const VALID_UUID = '00000000-0000-0000-0000-0000000000c5';

function makeReq(body: string | null = JSON.stringify({ reason: 'leaving' })): NextRequest {
  return new NextRequest(`http://localhost/api/admin/renewals/${VALID_UUID}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ?? '',
  });
}

function makeCtx() {
  return { params: Promise.resolve({ cycleId: VALID_UUID }) };
}

async function loadHandler() {
  const mod = await import('@/app/api/admin/renewals/[cycleId]/cancel/route');
  return mod.POST;
}

describe('POST /api/admin/renewals/[cycleId]/cancel — contract', () => {
  beforeEach(() => {
    f8FeatureFlag.value = true;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('503 when feature flag off', async () => {
    f8FeatureFlag.value = false;
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(503);
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
  });

  it('200 happy path with snake_case', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    cancelCycleMock.mockResolvedValueOnce(
      ok({ status: 'cancelled', closedAt: '2026-05-15T10:00:00.000Z' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('cancelled');
    expect(body.closed_at).toBe('2026-05-15T10:00:00.000Z');
  });

  it('400 invalid_body on malformed JSON', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq('not-json'), makeCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_body');
  });

  it('400 invalid_body when reason missing', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(makeReq(JSON.stringify({})), makeCtx());
    expect(res.status).toBe(400);
  });

  it('400 invalid_body when reason exceeds 500 chars', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    const POST = await loadHandler();
    const res = await POST(
      makeReq(JSON.stringify({ reason: 'x'.repeat(501) })),
      makeCtx(),
    );
    expect(res.status).toBe(400);
  });

  it('404 cycle_not_found', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    cancelCycleMock.mockResolvedValueOnce(err({ kind: 'cycle_not_found' }));
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(404);
  });

  it('409 cycle_not_cancellable with current_status payload', async () => {
    requireRenewalAdminContextMock.mockResolvedValueOnce(ADMIN_CTX);
    cancelCycleMock.mockResolvedValueOnce(
      err({ kind: 'cycle_not_cancellable', currentStatus: 'completed' }),
    );
    const POST = await loadHandler();
    const res = await POST(makeReq(), makeCtx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('cycle_not_cancellable');
    expect(body.error.current_status).toBe('completed');
  });
});
