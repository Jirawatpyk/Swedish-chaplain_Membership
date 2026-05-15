/**
 * GET /api/invoices/[invoiceId]/receipt/pdf — admin receipt-PDF download.
 *
 * Mirrors the byte-streaming pattern of `/api/invoices/[invoiceId]/pdf`
 * (R7-B1): the Blob URL is fetched server-side, bytes streamed through
 * this route with `Content-Disposition: attachment` so the public Blob
 * URL never reaches the browser.
 *
 * Error mapping (admin):
 *   - invoice_not_found    → 404
 *   - forbidden            → 403 (status !== 'paid', RBAC denial)
 *   - blob_missing         → 502
 *   - receipt_pdf_failed   → 502 with `reason` in body (admin only)
 *   - receipt_pdf_pending  → admin doesn't trigger this gate today;
 *                            return 425 for symmetry if it ever surfaces
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  getReceiptPdfSignedUrl,
  makeGetReceiptPdfSignedUrlDeps,
} from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'invoice',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // Wrap the use-case call so an audit-emit failure (Neon transient,
  // retention column constraint, etc.) surfaces as a structured 500
  // with stable error code instead of a bare Next.js framework 500.
  // The signed URL is already returned by the use-case on the success
  // path — losing the audit emit is regulatorily worse than failing
  // the download, hence we let the error propagate to the caller.
  let result: Awaited<ReturnType<typeof getReceiptPdfSignedUrl>>;
  try {
    result = await getReceiptPdfSignedUrl(
      makeGetReceiptPdfSignedUrlDeps(tenantCtx.slug),
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
      'GET /api/invoices/[id]/receipt/pdf — use-case threw (likely audit-emit failure)',
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
        // R9-E2 — surface the failing blob key / failure reason so
        // operators can immediately locate the offending blob or the
        // worker-side render error without joining back to invoices.
        ...(result.error.code === 'blob_missing'
          ? { blobKey: result.error.key }
          : {}),
        ...(result.error.code === 'receipt_pdf_failed'
          ? { reason: result.error.reason }
          : {}),
      },
      'GET /api/invoices/[id]/receipt/pdf failed',
    );
    if (result.error.code === 'receipt_pdf_pending') {
      return NextResponse.json(
        { error: { code: 'receipt_pdf_pending' } },
        {
          status: 425,
          headers: { 'Retry-After': String(result.error.retryAfterSeconds) },
        },
      );
    }
    if (result.error.code === 'receipt_pdf_failed') {
      // Admin sees the failure reason so they can take corrective action.
      // Reason is internal (sanitiseErrorReason pattern at use-case
      // boundaries) — safe to surface to admin context.
      return NextResponse.json(
        { error: { code: 'receipt_pdf_failed', reason: result.error.reason } },
        { status: 502 },
      );
    }
    const status =
      result.error.code === 'invoice_not_found'
        ? 404
        : result.error.code === 'blob_missing'
          ? 502
          : 403;
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }

  let blobResponse: Response;
  try {
    blobResponse = await fetch(result.value.url);
  } catch (err) {
    logger.error(
      { requestId, tenantId: tenantCtx.slug, invoiceId, err },
      'GET /api/invoices/[id]/receipt/pdf — blob fetch failed',
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
      'GET /api/invoices/[id]/receipt/pdf — blob upstream non-OK',
    );
    return NextResponse.json(
      { error: { code: 'blob_fetch_failed' } },
      { status: 502 },
    );
  }

  const raw = result.value.filename;
  const contentDisposition = buildAttachmentContentDisposition(raw);
  const contentLength = blobResponse.headers.get('content-length');

  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDisposition,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (contentLength) headers['Content-Length'] = contentLength;

  return new NextResponse(blobResponse.body, { status: 200, headers });
}
