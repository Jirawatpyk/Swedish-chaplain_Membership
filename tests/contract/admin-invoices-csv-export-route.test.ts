/**
 * F5R3 H-1 (2026-05-16) — Contract test for the
 * `/api/admin/invoices/export.csv` route handler (Phase 3 of the F4
 * receipt-surface plan).
 *
 * Pre-fix the route had ZERO test coverage. The use-case is covered
 * by tests/unit/invoicing/export-paid-invoices-csv.test.ts +
 * tests/integration/invoicing/export-paid-invoices-csv.test.ts, but
 * the route's wire-level concerns (RBAC cloak via requireAdminContext,
 * YYYY-MM-DD format probe, range error mapping → 400, success-path
 * Content-Disposition + X-Row-Count headers, UTF-8 BOM survives the
 * Response constructor) had nowhere to be asserted.
 *
 * Strategy: mock admin-context, tenant-context, request-id (auth/infra
 * seams) + the use-case (so we can drive every error variant). The
 * route's pure transformation of (auth context, query params,
 * use-case Result) → Response is exactly what this file pins.
 *
 * Mock policy: vi.mock at the auth + infra + use-case boundaries
 * only — the route's own code path (URL parse, regex, header
 * construction) runs unmodified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireAdminContextMock = vi.fn();
const exportPaidInvoicesCsvMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-csv-export-1',
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/invoicing', () => ({
  exportPaidInvoicesCsv: (...args: unknown[]) =>
    exportPaidInvoicesCsvMock(...args),
  makeExportPaidInvoicesCsvDeps: () => ({}),
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'admin@swecham.test',
      role: 'admin',
      status: 'active',
      displayName: 'Admin',
    },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-csv-export-1',
};

function buildGetRequest(qs: string): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/admin/invoices/export.csv${qs}`,
    { method: 'GET' },
  );
}

async function callRoute(qs: string): Promise<Response> {
  const { GET } = await import('@/app/api/admin/invoices/export.csv/route');
  return GET(buildGetRequest(qs));
}

describe('GET /api/admin/invoices/export.csv — route handler contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminContextMock.mockResolvedValue(adminContext);
  });
  afterEach(() => {
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // RBAC cloak — route MUST forward whatever requireAdminContext rejection
  // says (401 anonymous / 403 forbidden). The route does NOT cloak to 404
  // — that comment in the route is drift documented elsewhere (see code
  // review). What matters is that rejections are forwarded verbatim.
  // -------------------------------------------------------------------------

  it('anonymous (no session) → 401 forwarded from requireAdminContext', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), {
        status: 401,
      }),
    });

    const res = await callRoute('?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(401);
    expect(exportPaidInvoicesCsvMock).not.toHaveBeenCalled();
  });

  it('forbidden role → 403 forwarded from requireAdminContext', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
      }),
    });

    const res = await callRoute('?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(403);
    expect(exportPaidInvoicesCsvMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Query-param format probe — route bounces malformed `from`/`to` to
  // 400 `invalid_range_format` BEFORE dispatching the use-case (saves a
  // Neon round-trip on garbage input).
  // -------------------------------------------------------------------------

  it('missing both query params → 400 invalid_range_format', async () => {
    const res = await callRoute('');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_range_format');
    expect(exportPaidInvoicesCsvMock).not.toHaveBeenCalled();
  });

  it('missing `to` → 400 invalid_range_format', async () => {
    const res = await callRoute('?from=2026-05-01');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_range_format');
    expect(exportPaidInvoicesCsvMock).not.toHaveBeenCalled();
  });

  it('malformed `from` (YYYY-MM only) → 400 invalid_range_format', async () => {
    const res = await callRoute('?from=2026-05&to=2026-05-31');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_range_format');
    expect(exportPaidInvoicesCsvMock).not.toHaveBeenCalled();
  });

  it('malformed `to` (non-numeric) → 400 invalid_range_format', async () => {
    const res = await callRoute('?from=2026-05-01&to=2026-xx-31');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_range_format');
    expect(exportPaidInvoicesCsvMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Range-semantics errors from the use-case → 400 with the reason
  // discriminator. Pins the route's error mapping so a future Result
  // shape drift breaks CI before reaching prod.
  // -------------------------------------------------------------------------

  it('use-case returns invalid_range/inverted → 400 with reason=inverted', async () => {
    exportPaidInvoicesCsvMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_range', reason: 'inverted' },
    });
    const res = await callRoute('?from=2026-05-31&to=2026-05-01');
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; reason: string };
    };
    expect(body.error.code).toBe('invalid_range');
    expect(body.error.reason).toBe('inverted');
  });

  it('use-case returns invalid_range/too_wide → 400 with reason=too_wide', async () => {
    exportPaidInvoicesCsvMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_range', reason: 'too_wide' },
    });
    const res = await callRoute('?from=2025-01-01&to=2026-12-31');
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; reason: string };
    };
    expect(body.error.code).toBe('invalid_range');
    expect(body.error.reason).toBe('too_wide');
  });

  it('use-case returns list_failed → 500 server_error (no internal cause leak in body)', async () => {
    exportPaidInvoicesCsvMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'list_failed' },
    });
    const res = await callRoute('?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('server_error');
    // Body MUST NOT include the internal cause / stack / SQL fragment.
    expect(JSON.stringify(body)).not.toContain('list_failed');
  });

  // -------------------------------------------------------------------------
  // Happy path — Content-Type / Content-Disposition / X-Row-Count + UTF-8
  // BOM survives the Response constructor.
  // -------------------------------------------------------------------------

  it('admin success → 200 + text/csv + attachment Content-Disposition + X-Row-Count + UTF-8 BOM intact', async () => {
    // Explicit `﻿` byte-order-mark — TS source-file editors /
    // transformers may strip a literal BOM at file head, so we force
    // it via escape sequence.
    const bomCsv =
      String.fromCharCode(0xfeff) +
      'Issue Date,Invoice No.,Receipt No.\r\n2026-05-15,INV-1,RC-1\r\n';
    exportPaidInvoicesCsvMock.mockResolvedValueOnce({
      ok: true,
      value: {
        csv: bomCsv,
        filename: 'invoices-paid-2026-05-01-to-2026-05-31.csv',
        rowCount: 1,
      },
    });

    const res = await callRoute('?from=2026-05-01&to=2026-05-31');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-row-count')).toBe('1');

    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition.toLowerCase()).toContain('attachment');
    expect(disposition).toContain('invoices-paid-2026-05-01-to-2026-05-31.csv');

    // BOM must survive — Excel-TH renders Thai legal names without
    // forcing the import wizard ONLY when the leading EF BB BF
    // (UTF-8 encoding of U+FEFF) is intact in the WIRE bytes. We
    // assert against arrayBuffer (raw bytes) NOT .text() because the
    // WHATWG TextDecoder strips the BOM by default when decoding —
    // body.charCodeAt(0) would lie about what Excel actually receives.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    // Body still contains the data row after BOM + header.
    const decoded = new TextDecoder('utf-8').decode(bytes);
    expect(decoded).toContain('INV-1');
  });

  // -------------------------------------------------------------------------
  // Use-case dispatch arg shape — pins the route's actor + tenant wiring
  // so a refactor that drops actorUserId or threads the wrong field
  // breaks CI loudly (cross-tenant + auditing concern).
  // -------------------------------------------------------------------------

  it('passes actorUserId + tenantId + from/to + requestId to the use-case', async () => {
    exportPaidInvoicesCsvMock.mockResolvedValueOnce({
      ok: true,
      value: {
        csv: '﻿header\r\n',
        filename: 'x.csv',
        rowCount: 0,
      },
    });

    await callRoute('?from=2026-05-01&to=2026-05-31');

    expect(exportPaidInvoicesCsvMock).toHaveBeenCalledTimes(1);
    const callArgs = exportPaidInvoicesCsvMock.mock.calls[0]![1] as {
      tenantId: string;
      actorUserId: string;
      from: string;
      to: string;
      requestId: string;
    };
    expect(callArgs.tenantId).toBe('test-swecham');
    expect(callArgs.actorUserId).toBe('admin-1');
    expect(callArgs.from).toBe('2026-05-01');
    expect(callArgs.to).toBe('2026-05-31');
    expect(callArgs.requestId).toBe('req-csv-export-1');
  });
});
