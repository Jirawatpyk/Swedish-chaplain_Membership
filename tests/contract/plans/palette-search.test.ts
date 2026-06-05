/**
 * T064 — Contract test: GET /api/plans/search (US1, US6).
 *
 * Asserts the palette-search response shape per contracts/plans-api.md § 11.
 * Actions list is role-filtered: manager sees only read-category actions;
 * admin sees everything; member → 403.
 *
 * 055-member-number — added AS: member results include `member_number_display`
 * (formatted `SCCM-NNNN`) resolved via RLS-safe `runInTenant` + `getPrefix`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const searchPlansMock = vi.fn();
const buildPlansDepsMock = vi.fn();
// 055-member-number — runInTenant stub so we can supply a fake prefix
// without touching Neon.
const runInTenantMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
vi.mock('@/modules/plans/application/search-plans', () => ({
  searchPlans: (...args: unknown[]) => searchPlansMock(...args),
}));
// 055-member-number — directorySearch now returns a member with memberNumber
// so the route can format it. runInTenant is stubbed to return 'SCCM' prefix.
const mockMemberRow = {
  member: {
    memberId: 'member-uuid-1',
    companyName: 'Acme Co',
    status: 'active',
    memberNumber: 42,
  },
  primaryContact: { firstName: 'Jane', lastName: 'Doe' },
};
vi.mock('@/modules/members', async () => ({
  directorySearch: async () =>
    ok({ items: [mockMemberRow], nextCursor: null }),
  formatMemberNumber: (prefix: string, n: number) =>
    `${prefix}-${String(n).padStart(4, '0')}`,
  asMemberNumber: (n: number) => n,
}));
vi.mock('@/lib/db', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/db')>();
  return {
    ...actual,
    runInTenant: (...args: unknown[]) => runInTenantMock(...args),
  };
});
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

/** Helper: stub searchPlans + buildPlansDeps for the plans portion. */
function stubPlansOk(noPlans = false) {
  buildPlansDepsMock.mockReturnValueOnce({ tenant: { slug: 'test-swecham' } });
  searchPlansMock.mockResolvedValueOnce(
    ok({
      results: {
        plans: noPlans
          ? []
          : [
              {
                plan_id: 'premium',
                plan_year: 2026,
                plan_name: 'Premium',
                category: 'corporate',
                is_active: true,
                url: '/admin/plans/2026/premium',
              },
            ],
        actions: noPlans
          ? []
          : [{ id: 'plan.new', label: 'Create new plan', url: '/admin/plans/new' }],
        navigate: [{ id: 'plans.list', label: 'Plans list', url: '/admin/plans' }],
      },
    }),
  );
}

describe('contract: GET /api/plans/search (T064)', () => {
  beforeEach(() => {
    // resetModules() clears the dynamic-import cache for `@/app/api/plans/search/route`
    // so each `await import(...)` rebinds to the freshly-reset mocks below.
    // Without it, a prior test file's resolved-once mocks can leak into this suite
    // (observed: test #1 timeout + test #2 wrong role under full-suite parallelism).
    vi.resetModules();
    // 055-member-number — runInTenant stub: invoke the callback with a no-op tx
    // and return the result (simulates the real RLS wrapper).
    runInTenantMock.mockImplementation(
      (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
  });
  afterEach(() => {
    // resetAllMocks (vs clearAllMocks) also resets implementations, not just call history,
    // so the next test's `mockResolvedValueOnce` is the only resolution the mock returns.
    vi.resetAllMocks();
  });

  it('200 — returns { results: { plans, actions, navigate } } envelope', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    stubPlansOk();

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

  // 055-member-number — member hits include formatted display number
  it('200 — member results include member_number_display (SCCM-NNNN)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    stubPlansOk(true);
    // runInTenant stub calls the callback and returns 'SCCM' prefix from
    // a fake memberSettings.getPrefix implementation.
    runInTenantMock.mockImplementationOnce(
      (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        // The route passes `(tx) => deps.memberSettings.getPrefix(tx, tenantId)`.
        // Our vi.mock of @/modules/members stubs the directorySearch return but
        // does NOT stub memberSettings — the route resolves memberSettings from
        // buildMembersDeps. We bypass that by making runInTenant itself return
        // the prefix value directly (the fn is never invoked — we're stubbing the
        // whole transport, not the callback).
        Promise.resolve('SCCM'),
    );

    const { GET } = await import('@/app/api/plans/search/route');
    const res = await GET(makeRequest('acme'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { members: { member_number_display: string; company_name: string }[] };
    };
    expect(body.results.members).toHaveLength(1);
    const member = body.results.members[0];
    expect(member).toBeDefined();
    // The stub returns prefix 'SCCM' and mockMemberRow.member.memberNumber = 42
    expect(member!.member_number_display).toBe('SCCM-0042');
    expect(member!.company_name).toBe('Acme Co');
  });
});
