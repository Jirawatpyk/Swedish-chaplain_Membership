/**
 * T080 — GET /api/credit-notes/[creditNoteId]/pdf (F4 / US6).
 *
 * Streams the credit-note PDF bytes through this route. Mirrors
 * `/api/invoices/[id]/pdf` (R7-B1) — the public Vercel Blob URL is
 * never emitted to the client; the server fetches it and proxies.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  getCreditNotePdfSignedUrl,
  makeGetCreditNotePdfSignedUrlDeps,
} from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { streamPdfFromBlob } from '@/lib/stream-pdf-from-blob';
import { pdfRouteErrorStatus } from '@/lib/pdf-route-error-status';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ creditNoteId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'credit_note',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const { creditNoteId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  let result: Awaited<ReturnType<typeof getCreditNotePdfSignedUrl>>;
  try {
    result = await getCreditNotePdfSignedUrl(
      makeGetCreditNotePdfSignedUrlDeps(tenantCtx.slug),
      {
        tenantId: tenantCtx.slug,
        actorUserId: ctx.current.user.id,
        actorRole: ctx.current.user.role as 'admin' | 'manager',
        requestId,
        creditNoteId,
      },
    );
  } catch (err) {
    // Blob `head()` failure, repo row-map throws on corrupt data, or
    // any other unexpected throw escape the use-case. Without this
    // catch the route surfaces a 500 with no structured log.
    logger.error(
      { requestId, tenantId: tenantCtx.slug, creditNoteId, err: String(err) },
      'GET /api/credit-notes/[id]/pdf — unexpected error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }
  if (!result.ok) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, creditNoteId, errorCode: result.error.code },
      'GET /api/credit-notes/[id]/pdf failed',
    );
    return NextResponse.json(
      { error: { code: result.error.code } },
      { status: pdfRouteErrorStatus(result.error.code) },
    );
  }

  return streamPdfFromBlob({
    url: result.value.url,
    filename: result.value.filename,
    logContext: { requestId, tenantId: tenantCtx.slug, creditNoteId },
    route: '/api/credit-notes/[id]/pdf',
  });
}
