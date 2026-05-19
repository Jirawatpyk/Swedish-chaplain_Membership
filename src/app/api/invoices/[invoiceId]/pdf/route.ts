/**
 * GET /api/invoices/[invoiceId]/pdf — admin-scope invoice PDF download.
 *
 * Bytes are proxied through this route (R7-B1) so the signed Vercel
 * Blob URL never leaves the server; capture (history, email forward,
 * proxy log) cannot grant permanent untokenised access. R10-S1
 * extracted the fetch+stream stage to `streamPdfFromBlob` which adds
 * a 15s abort timeout (R10-E1) and is shared across all 6 PDF routes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getInvoicePdfSignedUrl, makeGetInvoicePdfSignedUrlDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { streamPdfFromBlob } from '@/lib/stream-pdf-from-blob';
import { pdfRouteErrorStatus } from '@/lib/pdf-route-error-status';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'read' });
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // The use-case emits an audit event on success; if `audit.emit`
  // throws (Neon transient, RLS constraint), the use-case rejects.
  // Map that to a structured 500 instead of letting the throw crash
  // the Next.js worker (parity with the receipt PDF route).
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
        // Surface the missing blob key so operators triaging
        // "Invoice PDF unavailable" toasts can locate the orphaned
        // object in Vercel Blob without joining back to the invoice row.
        ...(result.error.code === 'blob_missing'
          ? { blobKey: result.error.key }
          : {}),
      },
      'GET /api/invoices/[id]/pdf failed',
    );
    // Distinct status codes for distinct causes so operators can
    // telemetry-split "missing on Blob" from "access denied".
    return NextResponse.json(
      { error: { code: result.error.code } },
      { status: pdfRouteErrorStatus(result.error.code) },
    );
  }

  return streamPdfFromBlob({
    url: result.value.url,
    filename: result.value.filename,
    logContext: { requestId, tenantId: tenantCtx.slug, invoiceId },
    route: '/api/invoices/[id]/pdf',
  });
}
