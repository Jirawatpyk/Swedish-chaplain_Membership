/**
 * 088 US8 UX-B1 (T061e-2) — contract test:
 * POST /api/invoices/[invoiceId]/zero-rate-cert-upload.
 *
 * Route-level: pins the guard + the error→HTTP status map. The use-case is
 * mocked (its pipeline is unit-tested separately), so this verifies the route's
 * own code — multipart parse, admin guard, and status mapping.
 *
 *   clean          → 200 { blobKey }
 *   infected       → 422 zero_rate_cert_unsafe
 *   scan failed    → 422 zero_rate_cert_scan_failed
 *   bad MIME       → 415 zero_rate_cert_invalid_mime
 *   oversize       → 413 zero_rate_cert_too_large
 *   non-admin      → 403
 *   missing file   → 400 invalid_body
 *
 * Strategy mirrors issue-route-guard.contract.test.ts (mock infra seams + the
 * invoicing module's use-case/deps factory) + csv-import-api.test.ts (manual
 * multipart encoding — passing a FormData instance to NextRequest stalls in
 * vitest's Node runtime).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const uploadZeroRateCertMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-cert-upload-1',
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    uploadZeroRateCert: (...args: unknown[]) => uploadZeroRateCertMock(...args),
    makeUploadZeroRateCertDeps: () => ({}),
  };
});

const adminContext = {
  current: {
    user: { id: 'admin-user-1', email: 'admin@swecham.test', role: 'admin' as const },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-cert-upload-1',
};

const VALID_INVOICE_ID = '550e8400-e29b-41d4-a716-446655440099';
const routeParams = { params: Promise.resolve({ invoiceId: VALID_INVOICE_ID }) };

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import(
    '@/app/api/invoices/[invoiceId]/zero-rate-cert-upload/route'
  )) as { POST: RoutePost };
}

/** Build a multipart POST with (or without) a `file` part — manual encoding. */
function makeRequest(opts: { omitFile?: boolean } = {}): NextRequest {
  const boundary = `test-boundary-${Math.random().toString(36).slice(2)}`;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  if (opts.omitFile !== true) {
    parts.push(
      enc.encode(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="cert.pdf"',
          'Content-Type: application/pdf',
          '',
          '%PDF-1.4 fake cert bytes',
          '',
        ].join('\r\n'),
      ),
    );
  } else {
    parts.push(
      enc.encode(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="other"',
          '',
          'not-a-file',
          '',
        ].join('\r\n'),
      ),
    );
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.byteLength;
  }
  return new NextRequest(
    `http://localhost:3100/api/invoices/${VALID_INVOICE_ID}/zero-rate-cert-upload`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    },
  );
}

describe('contract: POST /api/invoices/[id]/zero-rate-cert-upload (088 UX-B1)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clean upload → 200 { blobKey }', async () => {
    uploadZeroRateCertMock.mockResolvedValueOnce(
      ok({ blobKey: 'invoicing/test-swecham/zero-rate-certs/x_123.pdf' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(), routeParams);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blobKey: string };
    expect(body.blobKey).toBe('invoicing/test-swecham/zero-rate-certs/x_123.pdf');
  });

  it('infected → 422 zero_rate_cert_unsafe', async () => {
    uploadZeroRateCertMock.mockResolvedValueOnce(
      err({ kind: 'zero_rate_cert_unsafe', reason: 'EICAR-Test' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(), routeParams);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('zero_rate_cert_unsafe');
  });

  it('scanner error/unconfigured → 422 zero_rate_cert_scan_failed', async () => {
    uploadZeroRateCertMock.mockResolvedValueOnce(
      err({ kind: 'zero_rate_cert_scan_failed', reason: 'scanner_unconfigured' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(), routeParams);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('zero_rate_cert_scan_failed');
  });

  it('bad MIME → 415 zero_rate_cert_invalid_mime', async () => {
    uploadZeroRateCertMock.mockResolvedValueOnce(
      err({ kind: 'zero_rate_cert_invalid_mime', receivedMime: 'image/svg+xml' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(), routeParams);
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('zero_rate_cert_invalid_mime');
  });

  it('oversize (use-case) → 413 zero_rate_cert_too_large', async () => {
    uploadZeroRateCertMock.mockResolvedValueOnce(
      err({ kind: 'zero_rate_cert_too_large', sizeBytes: 6_000_000 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(), routeParams);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('zero_rate_cert_too_large');
  });

  it('non-admin → 403 (guard short-circuits, use-case never runs)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(), routeParams);
    expect(res.status).toBe(403);
    expect(uploadZeroRateCertMock).not.toHaveBeenCalled();
  });

  it('missing file field → 400 invalid_body', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ omitFile: true }), routeParams);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(uploadZeroRateCertMock).not.toHaveBeenCalled();
  });
});
