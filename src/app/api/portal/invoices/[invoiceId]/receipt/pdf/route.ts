/**
 * GET /api/portal/invoices/[invoiceId]/receipt/pdf — member receipt download.
 *
 * Mirrors `/api/portal/invoices/[invoiceId]/pdf` (R7-B3) for the receipt
 * variant. Member-only via `requireMemberContext`; `getReceiptPdfSignedUrl`
 * enforces member ownership + the 425 Too Early gate when the async
 * worker hasn't yet stamped the receipt PDF.
 *
 * Members never see the `receipt_pdf_failed` reason payload — we strip
 * it to a generic 502.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMemberContext } from '@/lib/member-context';
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
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;

  // Same try/catch pattern as the admin route — audit-emit throws
  // must not surface as bare framework 500s.
  let result: Awaited<ReturnType<typeof getReceiptPdfSignedUrl>>;
  try {
    result = await getReceiptPdfSignedUrl(
      makeGetReceiptPdfSignedUrlDeps(ctx.tenant.slug),
      {
        tenantId: ctx.tenant.slug,
        actorUserId: ctx.current.user.id,
        actorRole: 'member',
        actorMemberId: ctx.memberId,
        requestId: ctx.requestId,
        invoiceId,
      },
    );
  } catch (err) {
    logger.error(
      { requestId: ctx.requestId, tenantId: ctx.tenant.slug, invoiceId, err },
      'GET /api/portal/invoices/[id]/receipt/pdf — use-case threw',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  if (!result.ok) {
    logger.warn(
      {
        requestId: ctx.requestId,
        tenantId: ctx.tenant.slug,
        invoiceId,
        errorCode: result.error.code,
        // R9-E2/E3 — surface key + reason server-side so operators
        // see the internal diagnostic that the member surface
        // deliberately strips. The 502 response to the member still
        // omits `reason` (privacy), but the pino log captures it.
        ...(result.error.code === 'blob_missing'
          ? { blobKey: result.error.key }
          : {}),
        ...(result.error.code === 'receipt_pdf_failed'
          ? { reason: result.error.reason }
          : {}),
      },
      'GET /api/portal/invoices/[id]/receipt/pdf failed',
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
      // Strip the internal `reason` for member surface — they get a
      // generic 502 ("receipt unavailable; please contact admin").
      return NextResponse.json(
        { error: { code: 'receipt_pdf_failed' } },
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
      { requestId: ctx.requestId, invoiceId, err },
      'portal receipt PDF — blob fetch failed',
    );
    return NextResponse.json(
      { error: { code: 'blob_fetch_failed' } },
      { status: 502 },
    );
  }
  if (!blobResponse.ok || !blobResponse.body) {
    // Logging parity with admin route — surface upstream Blob 5xx for
    // ops triage (H-10 review-fix Round 2). Member route previously
    // returned 502 silently → incidents took longer to root-cause.
    logger.error(
      {
        requestId: ctx.requestId,
        tenantId: ctx.tenant.slug,
        invoiceId,
        blobStatus: blobResponse.status,
      },
      'GET /api/portal/invoices/[id]/receipt/pdf — blob upstream non-OK',
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
