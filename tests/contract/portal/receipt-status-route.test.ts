/**
 * 088 T066a (FR-019) — Contract test: GET
 * /api/portal/invoices/[invoiceId]/receipt/status.
 *
 * The lightweight poll endpoint behind `<ReceiptStatusWatcher>`. It returns
 * ONLY the async receipt-PDF render status (`pending | rendered | failed |
 * null`) for the OWNING member — no PII (no amounts, numbers, emails). Ownership
 * + cross-tenant isolation are enforced via `getInvoice` with the member actor
 * (identical guard to the portal detail page + the receipt/pdf download route):
 * a non-owned / cross-tenant / missing invoice collapses to an opaque 404.
 *
 * Mocks member-context + getInvoice so no DB / session machinery runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const getInvoiceMock = vi.fn();
const makeGetInvoiceDepsMock = vi.fn((..._args: unknown[]) => ({}));

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/modules/invoicing', async () => {
  const actual =
    await vi.importActual<typeof import('@/modules/invoicing')>(
      '@/modules/invoicing',
    );
  return {
    ...actual,
    getInvoice: (...args: unknown[]) => getInvoiceMock(...args),
    makeGetInvoiceDeps: (...args: unknown[]) => makeGetInvoiceDepsMock(...args),
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const memberContext = {
  current: { user: { id: 'user-1', role: 'member' }, session: { id: 's-1' } },
  tenant: { slug: 'test-swecham', __brand: true },
  member: { memberId: 'mem-1' },
  memberId: 'mem-1',
  ownContact: { contactId: 'con-1' },
  ownContactId: 'con-1',
  sourceIp: '127.0.0.1',
  requestId: 'req-1',
};

function makeRequest(): NextRequest {
  return new NextRequest(
    'http://localhost/api/portal/invoices/inv-1/receipt/status',
    { method: 'GET' },
  );
}

const params = Promise.resolve({ invoiceId: 'inv-1' });

describe('contract: GET /api/portal/invoices/[id]/receipt/status (088 T066a)', () => {
  afterEach(() => vi.clearAllMocks());

  it('401 when member-context returns a rejection (no session)', { timeout: 30_000 }, async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { GET } = await import(
      '@/app/api/portal/invoices/[invoiceId]/receipt/status/route'
    );
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(401);
  });

  it('403 when the caller is not a member', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { GET } = await import(
      '@/app/api/portal/invoices/[invoiceId]/receipt/status/route'
    );
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(403);
  });

  it('200 returns ONLY { status } for the owning member (no PII)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    getInvoiceMock.mockResolvedValueOnce(
      ok({
        invoiceId: 'inv-1',
        memberId: 'mem-1',
        status: 'paid',
        receiptPdfStatus: 'pending',
        // Fields the route MUST NOT leak — assert they are absent below.
        total: { satang: 5_000_000n },
        memberIdentitySnapshot: { primary_contact_email: 'a@b.test' },
      }),
    );
    const { GET } = await import(
      '@/app/api/portal/invoices/[invoiceId]/receipt/status/route'
    );
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'pending' });
    // No amount / no email / no snapshot leaked.
    expect(JSON.stringify(body)).not.toContain('a@b.test');
    expect(JSON.stringify(body)).not.toContain('satang');

    // The member actor drives the ownership guard (cross-tenant probe emit).
    const call = getInvoiceMock.mock.calls[0];
    const input = call?.[1] as { actor?: { role?: string; memberId?: string } };
    expect(input?.actor?.role).toBe('member');
    expect(input?.actor?.memberId).toBe('mem-1');
  });

  it('404 (opaque) when getInvoice rejects — cross-tenant / non-owned / missing', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    getInvoiceMock.mockResolvedValueOnce(err({ code: 'not_found' }));
    const { GET } = await import(
      '@/app/api/portal/invoices/[invoiceId]/receipt/status/route'
    );
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(404);
  });

  it('200 with status:null for a non-paid invoice (no receipt yet)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    getInvoiceMock.mockResolvedValueOnce(
      ok({ invoiceId: 'inv-1', memberId: 'mem-1', status: 'issued', receiptPdfStatus: null }),
    );
    const { GET } = await import(
      '@/app/api/portal/invoices/[invoiceId]/receipt/status/route'
    );
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: unknown };
    expect(body.status).toBeNull();
  });

  it('500 when getInvoice throws (framework error not leaked)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    getInvoiceMock.mockRejectedValueOnce(new Error('boom'));
    const { GET } = await import(
      '@/app/api/portal/invoices/[invoiceId]/receipt/status/route'
    );
    const res = await GET(makeRequest(), { params });
    expect(res.status).toBe(500);
  });
});
