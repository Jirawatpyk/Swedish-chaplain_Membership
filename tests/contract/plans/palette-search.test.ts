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
// F5 Phase 6 refundable-invoice palette group — vi.fn()-backed so a test can
// drive the paid-invoice source + the remaining-refundable filter per-case
// (defaults set in beforeEach return an empty palette). Referenced inside the
// `@/modules/invoicing` + `@/modules/payments` factories below via closure
// (same hoist-safe pattern as `searchPlansMock` — the factory is invoked
// lazily on import, after these consts initialise).
const listInvoicesPagedMock = vi.fn();
const loadInvoicePaymentActivityMock = vi.fn();
const computeRemainingRefundableMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: (...args: unknown[]) => buildPlansDepsMock(...args),
}));
// Mock only `searchPlans`; keep the REAL `filterPaletteEntriesByFeature` (the
// route re-exports it through this same module and calls it to strip
// kill-switched entries — spreading the original lets that filtering genuinely
// run against the stub's entries instead of stubbing it away).
vi.mock('@/modules/plans/application/search-plans', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/plans/application/search-plans')>();
  return {
    ...actual,
    searchPlans: (...args: unknown[]) => searchPlansMock(...args),
  };
});
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
  // 055-member-number — the route resolves the per-tenant display prefix via
  // resolveMemberNumberPrefix(tenant, memberSettings) (the RLS-safe helper that
  // wraps runInTenant + settings.getPrefix). Stub it to the expected 'SCCM'
  // prefix so formatMemberNumber yields 'SCCM-0042'. (Without this export the
  // route's call is undefined → throws → caught → members:[] — the bug this fixes.)
  resolveMemberNumberPrefix: async () => 'SCCM',
}));
vi.mock('@/lib/db', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/db')>();
  return {
    ...actual,
    runInTenant: (...args: unknown[]) => runInTenantMock(...args),
  };
});
// F5 Phase 6 (T118a) — route augments the response with refundable-
// invoice fuzzy search for admin role. The paid-invoice + payment-activity
// sources are vi.fn()-backed (defaults in beforeEach return an empty palette
// so the existing tests never reach live infra); one test drives real rows.
// `displayDocumentNumber` MUST be provided — the route imports + calls it to
// resolve each refundable row's printed number (088 FR-030). The mock mirrors
// the real impl exactly (documentNumber-first, RC fallback, null when both
// absent) so the number-resolution is genuinely exercised, not stubbed away.
vi.mock('@/modules/invoicing', async () => ({
  listInvoicesPaged: (...args: unknown[]) => listInvoicesPagedMock(...args),
  makeListInvoicesDeps: () => ({}),
  displayDocumentNumber: (inv: {
    documentNumber: { raw: string } | null;
    receiptDocumentNumberRaw: string | null;
  }) => inv.documentNumber?.raw ?? inv.receiptDocumentNumberRaw ?? null,
}));
vi.mock('@/modules/payments', async () => ({
  loadInvoicePaymentActivity: (...args: unknown[]) =>
    loadInvoicePaymentActivityMock(...args),
  makeLoadInvoicePaymentActivityDeps: () => ({}),
  // Route imports computeRemainingRefundable from @/modules/payments; it MUST
  // be present (the prior mock omitted it — safe only because rows were always
  // empty). vi.fn()-backed so a test can force a positive remaining balance.
  computeRemainingRefundable: (...args: unknown[]) =>
    computeRemainingRefundableMock(...args),
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
    // Refundable-invoice palette group — empty-palette defaults so every
    // existing test sees `refundableInvoices: []`. The dedicated test below
    // overrides these to drive real rows.
    listInvoicesPagedMock.mockResolvedValue(ok({ rows: [], total: 0 }));
    loadInvoicePaymentActivityMock.mockResolvedValue(
      ok({ payments: [], refunds: [] }),
    );
    computeRemainingRefundableMock.mockReturnValue(null);
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
    // The route resolves the display prefix via resolveMemberNumberPrefix
    // (mocked to 'SCCM' above) + directorySearch (mocked to Acme Co #42), so the
    // response member carries member_number_display 'SCCM-0042'.

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

  // 088 FR-030 (fix #4) — refundable-invoice rows resolve their printed number
  // via displayDocumentNumber (documentNumber-first, RC fallback). A paid 088
  // invoice has a NULL §87 documentNumber → its §86/4 RC number must surface;
  // a legacy paid invoice keeps its §87 number. Locks route.ts line ~223.
  it('200 — refundable rows resolve invoice_number (088 RC fallback + legacy §87)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    stubPlansOk(true);

    // Paid 088 invoice: documentNumber NULL → number lives in its RC receipt.
    const row088 = {
      invoiceId: 'inv-088',
      documentNumber: null,
      receiptDocumentNumberRaw: 'RC-2026-000015',
      total: { satang: 53_500n },
      currency: 'THB',
      memberIdentitySnapshot: null,
    };
    // Legacy paid invoice: keeps its §87 documentNumber.
    const rowLegacy = {
      invoiceId: 'inv-legacy',
      documentNumber: { raw: 'IN-2026-000002' },
      receiptDocumentNumberRaw: null,
      total: { satang: 10_000n },
      currency: 'THB',
      memberIdentitySnapshot: null,
    };
    listInvoicesPagedMock.mockResolvedValueOnce(
      ok({ rows: [row088, rowLegacy], total: 2 }),
    );
    // Force a positive remaining balance so both rows survive the
    // per-invoice remaining-refundable filter (the refund math itself is
    // covered by loadInvoicePaymentActivity's own tests).
    computeRemainingRefundableMock.mockReturnValue({
      paymentId: 'pay-1',
      remainingSatang: 1_000n,
    });

    const { GET } = await import('@/app/api/plans/search/route');
    const res = await GET(makeRequest('inv'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: {
        refundableInvoices: {
          invoice_id: string;
          invoice_number: string;
        }[];
      };
    };
    const refundable = body.results.refundableInvoices;
    expect(refundable).toHaveLength(2);
    const numberById = Object.fromEntries(
      refundable.map((r) => [r.invoice_id, r.invoice_number]),
    );
    // 088 row → RC receipt number (documentNumber NULL fallback).
    expect(numberById['inv-088']).toBe('RC-2026-000015');
    // Legacy row → §87 document number.
    expect(numberById['inv-legacy']).toBe('IN-2026-000002');
  });
});
