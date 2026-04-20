/**
 * Contract test: GET /api/members/[memberId]/invoices (US7 / FR-032).
 *
 * Mocks `requireAdminContext`, `getMember`, `listInvoicesByMember`,
 * the tenant resolver, and related factories so the handler runs
 * without touching the real DB / session. Asserts response shape +
 * HTTP status for each branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const getMemberMock = vi.fn();
const listInvoicesByMemberMock = vi.fn();
const buildMembersDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    getMember: (...args: unknown[]) => getMemberMock(...args),
  };
});
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: (...args: unknown[]) => buildMembersDepsMock(...args),
}));
vi.mock('@/modules/invoicing', async () => {
  const actual = await vi.importActual<typeof import('@/modules/invoicing')>(
    '@/modules/invoicing',
  );
  return {
    ...actual,
    listInvoicesByMember: (...args: unknown[]) =>
      listInvoicesByMemberMock(...args),
    makeListInvoicesByMemberDeps: () => ({ invoiceRepo: {} }),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'a@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

const VALID_MEMBER = '00000000-0000-4000-8000-000000000001';

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

function minimalInvoice(overrides: Record<string, unknown> = {}): unknown {
  return {
    tenantId: 'test-swecham',
    invoiceId: 'inv-1',
    memberId: VALID_MEMBER,
    planId: 'p',
    planYear: 2026,
    status: 'issued',
    fiscalYear: 2026,
    sequenceNumber: 42,
    documentNumber: { raw: 'INV-2026-0042' },
    issueDate: '2026-04-01',
    dueDate: '2026-04-30',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: { satang: 100000n },
    vatRate: { raw: '0.0700' },
    vat: { satang: 7000n },
    total: { satang: 107000n },
    creditedTotal: { satang: 0n },
    pdf: null,
    autoEmailOnIssue: null,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    lines: [],
    ...overrides,
  };
}

describe('contract: GET /api/members/[memberId]/invoices', () => {
  afterEach(() => vi.clearAllMocks());

  it('401 when unauthenticated (requireAdminContext returns response)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }),
    });
    const { GET } = await import(
      '@/app/api/members/[memberId]/invoices/route'
    );
    const res = await GET(
      makeRequest(`http://localhost/api/members/${VALID_MEMBER}/invoices`),
      { params: Promise.resolve({ memberId: VALID_MEMBER }) },
    );
    expect(res.status).toBe(401);
  });

  it('404 when memberId is not a UUID', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { GET } = await import(
      '@/app/api/members/[memberId]/invoices/route'
    );
    const res = await GET(
      makeRequest(`http://localhost/api/members/not-a-uuid/invoices`),
      { params: Promise.resolve({ memberId: 'not-a-uuid' }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('400 when query params are invalid (status out of enum)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { GET } = await import(
      '@/app/api/members/[memberId]/invoices/route'
    );
    const res = await GET(
      makeRequest(
        `http://localhost/api/members/${VALID_MEMBER}/invoices?status=bogus`,
      ),
      { params: Promise.resolve({ memberId: VALID_MEMBER }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_query');
  });

  it('404 when member does not exist in this tenant (cross-tenant probe)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({ memberRepo: {}, audit: {} });
    getMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const { GET } = await import(
      '@/app/api/members/[memberId]/invoices/route'
    );
    const res = await GET(
      makeRequest(`http://localhost/api/members/${VALID_MEMBER}/invoices`),
      { params: Promise.resolve({ memberId: VALID_MEMBER }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('200 happy path — returns rows + total', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({ memberRepo: {}, audit: {} });
    getMemberMock.mockResolvedValueOnce(
      ok({
        member: { memberId: VALID_MEMBER, companyName: 'Acme' },
        contacts: [],
      }),
    );
    listInvoicesByMemberMock.mockResolvedValueOnce(
      ok({ rows: [minimalInvoice()], total: 1 }),
    );
    const { GET } = await import(
      '@/app/api/members/[memberId]/invoices/route'
    );
    const res = await GET(
      makeRequest(`http://localhost/api/members/${VALID_MEMBER}/invoices`),
      { params: Promise.resolve({ memberId: VALID_MEMBER }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows[0].invoice_id).toBe('inv-1');
    expect(body.rows[0].document_number).toBe('INV-2026-0042');
  });

  it('500 when use case surfaces repo_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({ memberRepo: {}, audit: {} });
    getMemberMock.mockResolvedValueOnce(
      ok({
        member: { memberId: VALID_MEMBER, companyName: 'Acme' },
        contacts: [],
      }),
    );
    listInvoicesByMemberMock.mockResolvedValueOnce(
      err({ type: 'repo_error', cause: new Error('neon down') }),
    );
    const { GET } = await import(
      '@/app/api/members/[memberId]/invoices/route'
    );
    const res = await GET(
      makeRequest(`http://localhost/api/members/${VALID_MEMBER}/invoices`),
      { params: Promise.resolve({ memberId: VALID_MEMBER }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });
});
