/**
 * T138 — Contract test: GET + PATCH /api/fee-config (US5, plans-api.md § 12–13).
 *
 * Scope:
 *   - GET 200 admin (full fee config payload shape)
 *   - GET 200 manager (read allowed)
 *   - GET 401 unauthenticated
 *   - PATCH 200 admin (vat_rate + registration_fee_minor_units update)
 *   - PATCH 400 invalid_body (vat_rate out of range)
 *   - PATCH 400 missing Idempotency-Key
 *   - PATCH 401 unauthenticated
 *   - PATCH 403 manager (forbidden — read-only on fee_config)
 *   - PATCH 409 idempotency_conflict
 *
 * Mocks: admin-context + plans deps + use cases + idempotency +
 * tenant-context + logger so the route handler runs without DB or session.
 * Real DB round-trips live in:
 *   - tests/integration/plans/fee-config-update.test.ts (T140)
 *   - tests/integration/plans/audit-diff-fee-config.test.ts (T142)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const getFeeConfigMock = vi.fn();
const updateFeeConfigMock = vi.fn();
const buildPlansDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
vi.mock('@/modules/plans', async () => {
  const actual = await vi.importActual<typeof import('@/modules/plans')>(
    '@/modules/plans',
  );
  return {
    ...actual,
    getFeeConfig: (...args: unknown[]) => getFeeConfigMock(...args),
    updateFeeConfig: (...args: unknown[]) => updateFeeConfigMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => undefined),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'deterministic-hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'admin@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-fee-1',
};

const SAMPLE_FEE_CONFIG = {
  tenant_id: 'test-swecham',
  currency_code: 'THB' as const,
  vat_rate: 0.07,
  registration_fee_minor_units: 100_000,
  updated_at: new Date('2026-04-11T10:00:00Z'),
  updated_by: 'admin-1',
};

function makeRequest(
  method: 'GET' | 'PATCH',
  body?: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-fee-1' },
): NextRequest {
  if (method === 'PATCH') {
    return new NextRequest('http://localhost/api/fee-config', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
    });
  }
  return new NextRequest('http://localhost/api/fee-config', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('contract: GET /api/fee-config (T138, US5)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 admin — returns full fee config payload', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    getFeeConfigMock.mockResolvedValueOnce(ok(SAMPLE_FEE_CONFIG));

    const { GET } = await import('@/app/api/fee-config/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant_id).toBe('test-swecham');
    expect(body.currency_code).toBe('THB');
    expect(body.vat_rate).toBe(0.07);
    expect(body.registration_fee_minor_units).toBe(100_000);
    expect(typeof body.registration_fee_display).toBe('string');
    expect(body.updated_at).toBe('2026-04-11T10:00:00.000Z');
  });

  it('200 manager — read allowed', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      ...adminContext,
      current: { ...adminContext.current, user: { ...adminContext.current.user, role: 'manager' } },
    });
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    getFeeConfigMock.mockResolvedValueOnce(ok(SAMPLE_FEE_CONFIG));

    const { GET } = await import('@/app/api/fee-config/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { GET } = await import('@/app/api/fee-config/route');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(401);
    expect(getFeeConfigMock).not.toHaveBeenCalled();
  });
});

describe('contract: PATCH /api/fee-config (T138, US5)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 admin — updates vat_rate + registration_fee', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updateFeeConfigMock.mockResolvedValueOnce(
      ok({ ...SAMPLE_FEE_CONFIG, vat_rate: 0.075 }),
    );

    const { PATCH } = await import('@/app/api/fee-config/route');
    const res = await PATCH(
      makeRequest('PATCH', { vat_rate: 0.075, registration_fee_minor_units: 150_000 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vat_rate).toBe(0.075);
  });

  it('400 invalid_body — vat_rate out of range', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updateFeeConfigMock.mockResolvedValueOnce(
      err({ type: 'invalid_body', issues: ['vat_rate: must be in [0, 1)'] }),
    );

    const { PATCH } = await import('@/app/api/fee-config/route');
    const res = await PATCH(makeRequest('PATCH', { vat_rate: 1.5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('invalid_body');
  });

  it('400 when Idempotency-Key header missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { PATCH } = await import('@/app/api/fee-config/route');
    const res = await PATCH(makeRequest('PATCH', { vat_rate: 0.08 }, {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('missing_idempotency_key');
    expect(updateFeeConfigMock).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { PATCH } = await import('@/app/api/fee-config/route');
    const res = await PATCH(makeRequest('PATCH', { vat_rate: 0.08 }));
    expect(res.status).toBe(401);
    expect(updateFeeConfigMock).not.toHaveBeenCalled();
  });

  it('403 manager — forbidden to PATCH fee_config', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { PATCH } = await import('@/app/api/fee-config/route');
    const res = await PATCH(makeRequest('PATCH', { vat_rate: 0.08 }));
    expect(res.status).toBe(403);
    expect(updateFeeConfigMock).not.toHaveBeenCalled();
  });

  it('409 idempotency_conflict when key replayed with different body', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    updateFeeConfigMock.mockResolvedValueOnce(
      err({ type: 'idempotency_conflict' }),
    );
    const { PATCH } = await import('@/app/api/fee-config/route');
    const res = await PATCH(makeRequest('PATCH', { vat_rate: 0.09 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error?.code).toBe('idempotency_conflict');
  });
});
