/**
 * T062 — Contract test: GET /api/plans (US1).
 *
 * Asserts the list-plans response shape per contracts/plans-api.md § 1.
 * Mocks `@/lib/admin-context` + `@/modules/plans/plans-deps` so the
 * handler runs without touching the real DB or session. Real DB
 * coverage lives in `tests/integration/plans/list-plans-filtering.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const listPlansMock = vi.fn();
const buildPlansDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));

vi.mock('@/modules/plans/application/list-plans', () => ({
  listPlans: (...args: unknown[]) => listPlansMock(...args),
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
  requestId: 'req-list-1',
};

const managerContext = {
  current: {
    user: { id: 'mgr-1', email: 'm@b.co', role: 'manager', status: 'active', displayName: 'M' },
    session: { id: 'sess-2' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-list-2',
};

function makeRequest(query: string = ''): NextRequest {
  return new NextRequest(`http://localhost/api/plans${query}`);
}

describe('contract: GET /api/plans (T062)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on success — returns data + meta envelope', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    listPlansMock.mockResolvedValueOnce(
      ok({
        data: [
          {
            plan_id: 'premium',
            plan_year: 2026,
            plan_name: { en: 'Premium', th: 'พรีเมียม', sv: 'Premium' },
            description: { en: 'Test description' },
            plan_category: 'corporate',
            member_type_scope: 'company',
            annual_fee_minor_units: 3_600_000,
            annual_fee_display: '฿36,000.00',
            vat_rate: 0.07,
            total_with_vat_minor_units: 3_852_000,
            total_with_vat_display: '฿38,520.00',
            includes_corporate_plan_id: null,
            is_active: true,
            deleted_at: null,
            created_at: '2026-04-11T10:00:00Z',
            updated_at: '2026-04-11T10:00:00Z',
            missing_translations: [],
          },
        ],
        meta: {
          total: 1,
          year: 2026,
          currency_code: 'THB',
          filter: { category: null, q: null, activeOnly: false, showDeleted: false },
        },
      }),
    );

    const { GET } = await import('@/app/api/plans/route');
    const res = await GET(makeRequest('?year=2026'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].plan_id).toBe('premium');
    expect(body.meta.currency_code).toBe('THB');
    expect(body.meta.filter.showDeleted).toBe(false);
  });

  it('200 for manager role (read-only access)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(managerContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    listPlansMock.mockResolvedValueOnce(
      ok({
        data: [],
        meta: { total: 0, year: 2026, currency_code: 'THB', filter: {} },
      }),
    );
    const { GET } = await import('@/app/api/plans/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it('401 when requireAdminContext rejects with no-session', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { GET } = await import('@/app/api/plans/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(listPlansMock).not.toHaveBeenCalled();
  });

  it('403 when requireAdminContext rejects with forbidden (member role)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { GET } = await import('@/app/api/plans/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    expect(listPlansMock).not.toHaveBeenCalled();
  });

  it('400 on invalid year query parameter', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { GET } = await import('@/app/api/plans/route');
    const res = await GET(makeRequest('?year=not-a-number'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe('invalid_query');
  });

  it('500 when use case returns an unexpected error variant', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    listPlansMock.mockResolvedValueOnce(err({ type: 'server_error', message: 'x' }));
    const { GET } = await import('@/app/api/plans/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});
