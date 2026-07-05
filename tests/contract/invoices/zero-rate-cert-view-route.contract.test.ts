/**
 * V3 (088 US8 UX-B1 verify-followup) — contract test:
 * GET /api/invoices/[invoiceId]/zero-rate-cert (the cert VIEW proxy).
 *
 * Route-level: pins the RBAC gate + the error→HTTP status map + the blob
 * byte-proxy. The use-case is mocked (its Result branches are unit-tested in
 * get-zero-rate-cert-signed-url.test.ts), so this verifies the route's own code:
 * the admin/manager read gate, the manager-read intent (FR-024 ratified — see the
 * route comment), and the status mapping.
 *
 *   admin        → 200 (streams the cert bytes with the upstream Content-Type)
 *   manager      → 200 (read-only staff; requireAdminContext action:'read' admits
 *                  manager — asserts the route threads actorRole='manager')
 *   member       → 403 (guard short-circuits; use-case never runs)
 *   cert missing → 404 (cert_not_attached)
 *   blob missing → 502 (blob_missing)
 *
 * Mirrors zero-rate-cert-upload-route.contract.test.ts (mock the infra seams +
 * the invoicing barrel via importOriginal + spread). The upstream Vercel Blob
 * `fetch` is stubbed so the happy path streams without a network round-trip.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const getZeroRateCertSignedUrlMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-cert-view-1',
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    getZeroRateCertSignedUrl: (...args: unknown[]) => getZeroRateCertSignedUrlMock(...args),
    makeGetZeroRateCertSignedUrlDeps: () => ({}),
  };
});

const adminContext = {
  current: {
    user: { id: 'admin-user-1', email: 'admin@swecham.test', role: 'admin' as const },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-cert-view-1',
};

const managerContext = {
  ...adminContext,
  current: {
    ...adminContext.current,
    user: { id: 'mgr-user-1', email: 'mgr@swecham.test', role: 'manager' as const },
  },
};

const VALID_INVOICE_ID = '550e8400-e29b-41d4-a716-446655440099';
const routeParams = { params: Promise.resolve({ invoiceId: VALID_INVOICE_ID }) };

type RouteGet = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import(
    '@/app/api/invoices/[invoiceId]/zero-rate-cert/route'
  )) as { GET: RouteGet };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/invoices/${VALID_INVOICE_ID}/zero-rate-cert`,
    { method: 'GET' },
  );
}

/**
 * A minimal upstream-Blob Response the route can proxy: `.ok`, a whatwg
 * `ReadableStream` `.body`, and a `Headers` with the cert's Content-Type. Avoids
 * a real network fetch + any `new Response(bytes).body` environment quirk.
 */
function okBlobResponse(contentType = 'application/pdf'): Response {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers({
      'content-type': contentType,
      'content-length': String(bytes.byteLength),
    }),
  } as unknown as Response;
}

describe('contract: GET /api/invoices/[id]/zero-rate-cert (088 UX-B1 cert view)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
    fetchMock.mockResolvedValue(okBlobResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('admin → 200 streams the cert bytes with the upstream Content-Type', async () => {
    getZeroRateCertSignedUrlMock.mockResolvedValueOnce(
      ok({ url: 'https://blob.test/cert.pdf', filename: 'zero-rate-cert-SC-2026-000012.pdf' }),
    );
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    // The route fetched the signed URL to proxy the bytes.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('manager → 200 (read-only staff admitted) and the route threads actorRole=manager', async () => {
    requireAdminContextMock.mockResolvedValueOnce(managerContext);
    getZeroRateCertSignedUrlMock.mockResolvedValueOnce(
      ok({ url: 'https://blob.test/cert.png', filename: 'zero-rate-cert-SC-2026-000012.png' }),
    );
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(200);
    // FR-024 ratified: manager (read-only staff) gets the cert view, consistent
    // with the invoice-PDF read gate (requireAdminContext action:'read').
    expect(getZeroRateCertSignedUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorRole: 'manager', invoiceId: VALID_INVOICE_ID }),
    );
  });

  it('member → 403 (guard short-circuits; use-case + fetch never run)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(403);
    expect(getZeroRateCertSignedUrlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cert missing → 404 cert_not_attached', async () => {
    getZeroRateCertSignedUrlMock.mockResolvedValueOnce(err({ code: 'cert_not_attached' }));
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('cert_not_attached');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invoice_not_found → 404 (same surface as cert_not_attached)', async () => {
    getZeroRateCertSignedUrlMock.mockResolvedValueOnce(err({ code: 'invoice_not_found' }));
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invoice_not_found');
  });

  it('blob missing → 502 blob_missing', async () => {
    getZeroRateCertSignedUrlMock.mockResolvedValueOnce(
      err({ code: 'blob_missing', key: 'invoicing/test-swecham/zero-rate-certs/x_1.pdf' }),
    );
    const { GET } = await importRoute();
    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('blob_missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
