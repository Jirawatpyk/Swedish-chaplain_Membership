/**
 * T063 — Contract test: GET /api/plans/[year]/[planId] (US1, US3).
 *
 * Asserts the get-one response shape per contracts/plans-api.md § 2.
 * 404-never-403: cross-tenant probes return 404, never 403, so
 * existence does not leak. On every 404 the handler appends a
 * `plan_not_found` audit event (request-path-side of critique E6).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const getPlanMock = vi.fn();
const buildPlansDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
vi.mock('@/modules/plans/application/get-plan', () => ({
  getPlan: (...args: unknown[]) => getPlanMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-get-1',
};

function makeRequest(year: string, planId: string): NextRequest {
  return new NextRequest(`http://localhost/api/plans/${year}/${planId}`);
}

const params = (year: string, planId: string) =>
  Promise.resolve({ year, planId });

describe('contract: GET /api/plans/[year]/[planId] (T063)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on found plan — returns the full plan object', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    getPlanMock.mockResolvedValueOnce(
      ok({
        plan_id: 'premium',
        plan_year: 2026,
        plan_name: { en: 'Premium' },
        description: { en: '' },
        sort_order: 10,
        plan_category: 'corporate',
        member_type_scope: 'company',
        annual_fee_minor_units: 3_600_000,
        includes_corporate_plan_id: null,
        min_turnover_minor_units: null,
        max_turnover_minor_units: null,
        max_duration_years: null,
        max_member_age: null,
        benefit_matrix: {},
        is_active: true,
        deleted_at: null,
        created_at: new Date('2026-04-11T10:00:00Z'),
        updated_at: new Date('2026-04-11T10:00:00Z'),
      }),
    );

    const { GET } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await GET(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan_id).toBe('premium');
  });

  it('404 on not_found — never 403 on cross-tenant probe', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    getPlanMock.mockResolvedValueOnce(err({ type: 'not_found' }));

    const { GET } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await GET(makeRequest('2026', 'ghost'), {
      params: params('2026', 'ghost'),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe('not_found');
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { GET } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await GET(makeRequest('2026', 'premium'), {
      params: params('2026', 'premium'),
    });
    expect(res.status).toBe(401);
    expect(getPlanMock).not.toHaveBeenCalled();
  });

  it('400 on malformed path params (non-numeric year)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { GET } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await GET(makeRequest('notayear', 'premium'), {
      params: params('notayear', 'premium'),
    });
    expect(res.status).toBe(400);
    expect(getPlanMock).not.toHaveBeenCalled();
  });

  it('400 on malformed plan slug (uppercase)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { GET } = await import('@/app/api/plans/[year]/[planId]/route');
    const res = await GET(makeRequest('2026', 'Premium'), {
      params: params('2026', 'Premium'),
    });
    expect(res.status).toBe(400);
    expect(getPlanMock).not.toHaveBeenCalled();
  });
});
