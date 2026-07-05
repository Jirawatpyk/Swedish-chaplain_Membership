/**
 * 088 US8 UX-B1 (T061e-3) — GET /api/invoices/[invoiceId]/zero-rate-cert
 *
 * Admin/manager-only retrieval of the 10y-retained §80/1(5) zero-rate
 * certificate SCAN pinned on an issued invoice (FR-024: "retained separately,
 * 10y, admin-only"). Bytes are proxied through this auth-guarded route so the
 * public Vercel Blob URL never leaves the server (R7-B1 parity with the PDF
 * routes).
 *
 * The cert scan may be a PDF, PNG, or JPEG — so, unlike `streamPdfFromBlob`
 * (which hardcodes `application/pdf`), this route passes the upstream Blob
 * Content-Type through. Runtime pinned to Node (Vercel Blob fetch).
 *
 * Error → HTTP map (via `getZeroRateCertSignedUrl`):
 *   - invoice_not_found  → 404
 *   - cert_not_attached  → 404 (invoice exists but has no scan; cert NUMBER-only)
 *   - blob_missing       → 502
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  getZeroRateCertSignedUrl,
  makeGetZeroRateCertSignedUrlDeps,
} from '@/modules/invoicing';
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

function certViewErrorStatus(code: string): number {
  switch (code) {
    case 'invoice_not_found':
    case 'cert_not_attached':
      return 404;
    case 'blob_missing':
      return 502;
    default:
      return 500;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  // FR-024 says "admin-only", but `action:'read'` intentionally admits MANAGER
  // (read-only staff) too — ratified to match the invoice-PDF read gate: a
  // manager who can already view the tax invoice/receipt can view its supporting
  // §80/1(5) cert scan. No write/delete path is exposed to manager.
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'read' });
  if ('response' in ctx) return ctx.response;

  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  let result: Awaited<ReturnType<typeof getZeroRateCertSignedUrl>>;
  try {
    result = await getZeroRateCertSignedUrl(
      makeGetZeroRateCertSignedUrlDeps(tenantCtx.slug),
      {
        tenantId: tenantCtx.slug,
        actorUserId: ctx.current.user.id,
        // requireAdminContext(invoice, read) admits only admin + manager; the
        // cert scan is staff-only supporting evidence.
        actorRole: ctx.current.user.role === 'manager' ? 'manager' : 'admin',
        requestId,
        invoiceId,
      },
    );
  } catch (err) {
    logger.error(
      { requestId, tenantId: tenantCtx.slug, invoiceId, err },
      'GET /api/invoices/[id]/zero-rate-cert — getZeroRateCertSignedUrl threw',
    );
    return NextResponse.json({ error: { code: 'internal_error' } }, { status: 500 });
  }

  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        errorCode: result.error.code,
        ...(result.error.code === 'blob_missing' ? { blobKey: result.error.key } : {}),
      },
      'GET /api/invoices/[id]/zero-rate-cert failed',
    );
    return NextResponse.json(
      { error: { code: result.error.code } },
      { status: certViewErrorStatus(result.error.code) },
    );
  }

  // Stream the bytes with the upstream Content-Type (PDF / PNG / JPEG).
  let blobResponse: Response;
  try {
    blobResponse = await fetch(result.value.url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    logger.error(
      { requestId, tenantId: tenantCtx.slug, invoiceId, err },
      `GET /api/invoices/[id]/zero-rate-cert — blob fetch ${isTimeout ? 'timed out' : 'failed'}`,
    );
    return NextResponse.json(
      { error: { code: isTimeout ? 'blob_fetch_timeout' : 'blob_fetch_failed' } },
      { status: 502 },
    );
  }
  if (!blobResponse.ok || !blobResponse.body) {
    logger.error(
      { requestId, tenantId: tenantCtx.slug, invoiceId, blobStatus: blobResponse.status },
      'GET /api/invoices/[id]/zero-rate-cert — blob upstream non-OK',
    );
    return NextResponse.json({ error: { code: 'blob_fetch_failed' } }, { status: 502 });
  }

  const headers: Record<string, string> = {
    'Content-Type': blobResponse.headers.get('content-type') ?? 'application/octet-stream',
    'Content-Disposition': buildAttachmentContentDisposition(result.value.filename, {
      logger,
      context: '/api/invoices/[id]/zero-rate-cert',
    }),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const contentLength = blobResponse.headers.get('content-length');
  if (contentLength) headers['Content-Length'] = contentLength;

  return new NextResponse(blobResponse.body, { status: 200, headers });
}
