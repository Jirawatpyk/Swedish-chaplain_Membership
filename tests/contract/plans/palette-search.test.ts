/**
 * T064 — Contract test: GET /api/plans/search (US1, US6).
 *
 * Asserts the palette-search response shape per contracts/plans-api.md § 11.
 * Actions list is role-filtered: manager sees only read-category actions;
 * admin sees everything; member → 403.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const searchPlansMock = vi.fn();
const buildPlansDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
vi.mock('@/modules/plans/application/search-plans', () => ({
  searchPlans: (...args: unknown[]) => searchPlansMock(...args),
}));
// T069 — the route also calls directorySearch for the members group.
// In contract tests we stub it to an empty OK response; members-search
// has its own dedicated tests.
vi.mock('@/modules/members', async () => ({
  directorySearch: async () => ok({ items: [], nextCursor: null }),
}));
// F5 Phase 6 (T118a) — route augments the response with refundable-
// invoice fuzzy search for admin role. Contract test stubs these to
// empty OK so the new branch doesn't reach live infra; the dedicated
// `palette.refundableInvoices` group has its own tests downstream.
vi.mock('@/modules/invoicing', async () => ({
  listInvoicesPaged: async () => ok({ rows: [], total: 0 }),
  makeListInvoicesDeps: () => ({}),
}));
vi.mock('@/modules/payments', async () => ({
  loadInvoicePaymentActivity: async () => ok({ payments: [], refunds: [] }),
  makeLoadInvoicePaymentActivityDeps: () => ({}),
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
  requestId: 'req-search-1',
};
const managerContext = {
  current: {
    user: { id: 'mgr-1', email: 'm@b.co', role: 'manager', status: 'active', displayName: 'M' },
    session: { id: 'sess-2' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-search-2',
};

function makeRequest(q: string = '', extra: string = ''): NextRequest {
  return new NextRequest(`http://localhost/api/plans/search?q=${q}${extra}`);
}

describe('contract: GET /api/plans/search (T064)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 — returns { results: { plans, actions, navigate } } envelope', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    searchPlansMock.mockResolvedValueOnce(
      ok({
        results: {
          plans: [
            {
              plan_id: 'premium',
              plan_year: 2026,
              plan_name: 'Premium',
              category: 'corporate',
              is_active: true,
              url: '/admin/plans/2026/premium',
            },
          ],
          actions: [{ id: 'plan.new', label: 'Create new plan', url: '/admin/plans/new' }],
          navigate: [{ id: 'plans.list', label: 'Plans list', url: '/admin/plans' }],
        },
      }),
    );

    const { GET } = await import('@/app/api/plans/search/route');
    const res = await GET(makeRequest('prem'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.plans).toHaveLength(1);
    expect(body.results.actions).toHaveLength(1);
    expect(body.results.navigate).toHaveLength(1);
  });

  it('200 — manager gets filtered actions (no create/clone)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(managerContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    searchPlansMock.mockResolvedValueOnce(
      ok({
        results: {
          plans: [],
          actions: [], // manager role-filter returns no write-side actions
          navigate: [{ id: 'plans.list', label: 'Plans list', url: '/admin/plans' }],
        },
      }),
    );

    const { GET } = await import('@/app/api/plans/search/route');
    const res = await GET(makeRequest('anything'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.actions).toHaveLength(0);
    // Use case is called with role so it can filter
    expect(searchPlansMock).toHaveBeenCalled();
    const callArg = searchPlansMock.mock.calls[0]?.[0];
    expect(callArg.role).toBe('manager');
  });

  it('400 when q is missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
    const { GET } = await import('@/app/api/plans/search/route');
    const res = await GET(new NextRequest('http://localhost/api/plans/search'));
    expect(res.status).toBe(400);
    expect(searchPlansMock).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { GET } = await import('@/app/api/plans/search/route');
    const res = await GET(makeRequest('anything'));
    expect(res.status).toBe(401);
    expect(searchPlansMock).not.toHaveBeenCalled();
  });
});
