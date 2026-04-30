/**
 * T125a-test — Contract test: GET /api/admin/broadcasts/sla-stats.
 *
 * Wave 6 GREEN. Spec authority: contracts/broadcasts-api.md § 2.7.
 *
 * Pattern mirrors F5 contract tests (vi.mock seams + dynamic route
 * import). The aggregate query is mocked at the `runInTenant` boundary
 * so we exercise the route handler's severity computation + envelope
 * shape without touching live Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireAdminContextMock = vi.fn();
const runInTenantMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/db', () => ({
  runInTenant: (...args: unknown[]) => runInTenantMock(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const adminCtx = {
  current: {
    user: {
      id: 'user-admin-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.10',
  requestId: 'req-sla-1',
};
const managerCtx = {
  ...adminCtx,
  current: {
    ...adminCtx.current,
    user: { ...adminCtx.current.user, role: 'manager' as const },
  },
};
const unauthorisedResponse = NextResponse.json(
  { error: 'unauthorized' },
  { status: 401 },
);
const forbiddenResponse = NextResponse.json(
  { error: 'forbidden' },
  { status: 403 },
);

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/admin/broadcasts/sla-stats', {
    method: 'GET',
  });
}

async function importRoute() {
  return import('@/app/api/admin/broadcasts/sla-stats/route');
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/broadcasts/sla-stats — Wave 6 GREEN (T125a)', () => {
  it('200: full envelope shape with stats', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    runInTenantMock.mockResolvedValueOnce([
      { decision_count: 10, median_hours: 18.5, p95_hours: 36.2 },
    ]);
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      targetSlaHours: 48,
      rollingWindow: '30d',
      medianTimeToDecisionHours: 18.5,
      p95TimeToDecisionHours: 36.2,
      decisionCount: 10,
      bannerSeverity: 'green',
    });
    expect(typeof body.computedAt).toBe('string');
  });

  it('zero data path: medianTimeToDecisionHours=null, decisionCount=0, severity=green', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    runInTenantMock.mockResolvedValueOnce([
      { decision_count: 0, median_hours: null, p95_hours: null },
    ]);
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.medianTimeToDecisionHours).toBeNull();
    expect(body.p95TimeToDecisionHours).toBeNull();
    expect(body.decisionCount).toBe(0);
    expect(body.bannerSeverity).toBe('green');
  });

  it('banner severity = green when median ≤24h AND p95 ≤40h', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    runInTenantMock.mockResolvedValueOnce([
      { decision_count: 5, median_hours: 23.9, p95_hours: 39.9 },
    ]);
    const { GET } = await importRoute();
    const body = await (await GET(makeRequest())).json();
    expect(body.bannerSeverity).toBe('green');
  });

  it('banner severity = amber when median > 24h (and p95 ≤48h)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    runInTenantMock.mockResolvedValueOnce([
      { decision_count: 5, median_hours: 25, p95_hours: 35 },
    ]);
    const { GET } = await importRoute();
    const body = await (await GET(makeRequest())).json();
    expect(body.bannerSeverity).toBe('amber');
  });

  it('banner severity = amber when p95 > 40h (and p95 ≤48h)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    runInTenantMock.mockResolvedValueOnce([
      { decision_count: 5, median_hours: 20, p95_hours: 41 },
    ]);
    const { GET } = await importRoute();
    const body = await (await GET(makeRequest())).json();
    expect(body.bannerSeverity).toBe('amber');
  });

  it('banner severity = red when p95 > 48h (SC-002 breach)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    runInTenantMock.mockResolvedValueOnce([
      { decision_count: 5, median_hours: 30, p95_hours: 60 },
    ]);
    const { GET } = await importRoute();
    const body = await (await GET(makeRequest())).json();
    expect(body.bannerSeverity).toBe('red');
  });

  it('401: unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: unauthorisedResponse,
    });
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(runInTenantMock).not.toHaveBeenCalled();
  });

  it('403: member attempting access (admin-context guard rejects)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: forbiddenResponse,
    });
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
  });

  it('200: manager role allowed (read-only access)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(managerCtx);
    runInTenantMock.mockResolvedValueOnce([
      { decision_count: 3, median_hours: 12, p95_hours: 22 },
    ]);
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it('aggregation runs inside runInTenant (RLS scoping)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    runInTenantMock.mockResolvedValueOnce([
      { decision_count: 1, median_hours: 1, p95_hours: 1 },
    ]);
    const { GET } = await importRoute();
    await GET(makeRequest());
    expect(runInTenantMock).toHaveBeenCalledTimes(1);
    const firstArg = runInTenantMock.mock.calls[0]?.[0] as { slug: string };
    expect(firstArg?.slug).toBe('test-tenant');
  });

  it('500: unexpected error returns internal_error envelope', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    runInTenantMock.mockRejectedValueOnce(new Error('db down'));
    const { GET } = await importRoute();
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal_error');
  });
});
