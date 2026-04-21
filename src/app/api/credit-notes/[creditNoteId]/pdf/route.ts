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
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';

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
    const status =
      result.error.code === 'credit_note_not_found' ? 404
      : result.error.code === 'blob_missing' ? 502
      : 500;
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }

  let blobResponse: Response;
  try {
    blobResponse = await fetch(result.value.url);
  } catch (err) {
    logger.error(
      { requestId, tenantId: tenantCtx.slug, creditNoteId, err },
      'GET /api/credit-notes/[id]/pdf — blob fetch failed',
    );
    return NextResponse.json({ error: { code: 'blob_fetch_failed' } }, { status: 502 });
  }
  if (!blobResponse.ok || !blobResponse.body) {
    logger.error(
      { requestId, tenantId: tenantCtx.slug, creditNoteId, blobStatus: blobResponse.status },
      'GET /api/credit-notes/[id]/pdf — blob upstream non-OK',
    );
    return NextResponse.json({ error: { code: 'blob_fetch_failed' } }, { status: 502 });
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
