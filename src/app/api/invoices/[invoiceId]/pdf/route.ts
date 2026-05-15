/**
 * T055 + R7-B1 — GET /api/invoices/[invoiceId]/pdf.
 *
 * Historically this route 307-redirected to a public Vercel Blob URL.
 * That URL is stable + permanent + untokenized — any capture (browser
 * history, email forwarding, corp SWG, proxy logs, screenshot) grants
 * anonymous access to financial PII for the life of the Blob.
 *
 * B1 fix: stream the PDF bytes THROUGH this route. The Blob URL is
 * never emitted to the client; only server-to-Blob traffic is via
 * the URL. Clients see `Content-Disposition: attachment` + the bytes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getInvoicePdfSignedUrl, makeGetInvoicePdfSignedUrlDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'read' });
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // R8-L2-code — wrap the use-case call in try/catch parity with the
  // receipt-PDF route. The use-case now (R8-M1-code) emits an audit
  // event on success; if `audit.emit` throws (Neon transient, RLS
  // constraint), the use-case rejects, and we MUST map that to a
  // structured 500 instead of letting the route handler crash the
  // Next.js worker. Same shape as `/receipt/pdf/route.ts` try/catch.
  let result: Awaited<ReturnType<typeof getInvoicePdfSignedUrl>>;
  try {
    result = await getInvoicePdfSignedUrl(
      makeGetInvoicePdfSignedUrlDeps(tenantCtx.slug),
      {
        tenantId: tenantCtx.slug,
        actorUserId: ctx.current.user.id,
        actorRole: ctx.current.user.role,
        requestId,
        invoiceId,
      },
    );
  } catch (err) {
    logger.error(
      { requestId, tenantId: tenantCtx.slug, invoiceId, err },
      'GET /api/invoices/[id]/pdf — getInvoicePdfSignedUrl threw',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }
  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        errorCode: result.error.code,
      },
      'GET /api/invoices/[id]/pdf failed',
    );
    // R7-S5 — distinct status codes for distinct causes so operators
    // can telemetry-split "missing on Blob" from "access denied".
    const status =
      result.error.code === 'invoice_not_found'
        ? 404
        : result.error.code === 'blob_missing'
          ? 502
          : 403;
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }

  // R7-B1 — server-side fetch of the Blob URL. The signed URL (still
  // a stable public URL in the current @vercel/blob SDK) is used only
  // to read bytes on the server; it never leaves this process.
  let blobResponse: Response;
  try {
    blobResponse = await fetch(result.value.url);
  } catch (err) {
    logger.error(
      { requestId, tenantId: tenantCtx.slug, invoiceId, err },
      'GET /api/invoices/[id]/pdf — blob fetch failed',
    );
    return NextResponse.json(
      { error: { code: 'blob_fetch_failed' } },
      { status: 502 },
    );
  }
  if (!blobResponse.ok || !blobResponse.body) {
    logger.error(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        blobStatus: blobResponse.status,
      },
      'GET /api/invoices/[id]/pdf — blob upstream non-OK',
    );
    return NextResponse.json(
      { error: { code: 'blob_fetch_failed' } },
      { status: 502 },
    );
  }

  // RFC 6266-compliant Content-Disposition — shared helper applies
  // CR/LF + quote + non-ASCII sanitisation (T121).
  const raw = result.value.filename;
  const contentDisposition = buildAttachmentContentDisposition(raw);
  const contentLength = blobResponse.headers.get('content-length');

  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDisposition,
    'Cache-Control': 'no-store',
    // Signal to middleboxes that the response is opaque to content
    // sniffing — browsers should not reinterpret the bytes.
    'X-Content-Type-Options': 'nosniff',
  };
  if (contentLength) headers['Content-Length'] = contentLength;

  return new NextResponse(blobResponse.body, { status: 200, headers });
}
