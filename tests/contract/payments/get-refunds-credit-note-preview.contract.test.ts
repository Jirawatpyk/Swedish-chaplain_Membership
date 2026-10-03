/**
 * Spec 122 US8b follow-up — Contract: GET /api/refunds/credit-note-preview.
 *
 * The refund dialog's "Credit note to be issued" rows read the split from the
 * server, never from browser arithmetic. This route is a READ: same RBAC as
 * the refund itself (`refunds.write`), its own rate-limit bucket, the F5
 * envelope (`Cache-Control: no-store, private`, `X-Correlation-Id`) and satang
 * as decimal strings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const previewMock = vi.fn();
const rateLimitCheckMock = vi.fn(async (..._args: unknown[]) => ({ success: true, reset: Date.now() + 60_000 }));

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-cnp-1' }));
vi.mock('@/modules/invoicing', () => ({
  previewRefundCreditNote: (...args: unknown[]) => previewMock(...args),
  makeGetInvoiceDeps: (tenantId: string) => ({ tenantId }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const INVOICE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const adminContext = {
  current: {
    user: { id: 'user-admin-1', email: 'admin@swecham.test', role: 'admin' as const, status: 'active' as const },
    session: { id: 'sess-admin-1' },
  },
};

async function importRoute() {
  return (await import('@/app/api/refunds/credit-note-preview/route')) as unknown as {
    GET: (req: NextRequest) => Promise<Response>;
  };
}

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/refunds/credit-note-preview?${query}`, { method: 'GET' });
}

async function get(query: string) {
  const { GET } = await importRoute();
  return GET(req(query));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/refunds/credit-note-preview', () => {
  it('200 issue — the split as satang strings, with the invoice VAT rate', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    previewMock.mockResolvedValueOnce(
      ok({ kind: 'issue', netSatang: 500_000n, vatSatang: 35_000n, vatRateRaw: '0.0700' }),
    );
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(res.headers.get('X-Correlation-Id')).toBeTruthy();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['creditNote']).toEqual({ kind: 'issue', netSatang: '500000', vatSatang: '35000', vatRate: '0.0700' });
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'refunds.write');
    expect(previewMock).toHaveBeenCalledWith(
      { tenantId: 'test-swecham' },
      { tenantId: 'test-swecham', invoiceId: INVOICE_ID, creditTotalSatang: 535_000n },
    );
  });

  it('200 waived — a §105 receipt carries no VAT figures at all', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    previewMock.mockResolvedValueOnce(ok({ kind: 'waived', reason: 'section_105_receipt' }));
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['creditNote']).toEqual({ kind: 'waived', reason: 'section_105_receipt' });
  });

  it('200 blocked', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    previewMock.mockResolvedValueOnce(ok({ kind: 'blocked' }));
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['creditNote']).toEqual({ kind: 'blocked' });
  });

  it.each([
    ['missing amount', `invoiceId=${INVOICE_ID}`],
    ['zero amount', `invoiceId=${INVOICE_ID}&amountSatang=0`],
    ['decimal amount', `invoiceId=${INVOICE_ID}&amountSatang=12.5`],
    ['amount above the 20M THB cap', `invoiceId=${INVOICE_ID}&amountSatang=2000000001`],
    ['malformed invoice id', 'invoiceId=nope&amountSatang=535000'],
  ])('400 invalid_input — %s', async (_label, query) => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const res = await get(query);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; messageThai: string } };
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.messageThai).toBeTruthy();
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('401 — no session', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), { status: 401 }),
    });
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(401);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('403 — a manager cannot read it (refunds are admin-only)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    });
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(403);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('404 invoice_not_accessible — not found in this tenant', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    previewMock.mockResolvedValueOnce(err({ code: 'not_found' }));
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invoice_not_accessible');
  });

  it('409 refund_exceeds_remaining — quotes the server headroom', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    previewMock.mockResolvedValueOnce(err({ code: 'exceeds_remainder', remainingSatang: 3_317_000n }));
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=3852000`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; remainingSatang: string } };
    expect(body.error.code).toBe('refund_exceeds_remaining');
    expect(body.error.remainingSatang).toBe('3317000');
  });

  it('422 invoice_data_corrupt', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    previewMock.mockResolvedValueOnce(err({ code: 'invoice_data_corrupt' }));
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(422);
  });

  it('429 rate_limited with Retry-After, on its own bucket', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({ success: false, reset: Date.now() + 30_000 });
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(rateLimitCheckMock.mock.calls[0]?.[0]).toBe('refunds.credit_note_preview:test-swecham:user-admin-1');
    expect(previewMock).not.toHaveBeenCalled();
  });

  it('500 internal_error — a thrown read never leaks', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    previewMock.mockRejectedValueOnce(new Error('neon down: secret dsn'));
    const res = await get(`invoiceId=${INVOICE_ID}&amountSatang=535000`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('internal_error');
    expect(text).not.toContain('secret dsn');
  });
});
