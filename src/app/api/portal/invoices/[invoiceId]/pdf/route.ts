/**
 * R7-B3 — GET /api/portal/invoices/[invoiceId]/pdf (F4 US3).
 *
 * Member-scope PDF download. Mirrors the admin B1 byte-streaming
 * pattern: fetch bytes from Blob server-side, stream to client with
 * `Content-Disposition: attachment`. The Blob URL never leaves this
 * Node process.
 *
 * Access control:
 *   - `requireMemberContext` — resolves member from the linked user
 *   - `getInvoicePdfSignedUrl` with `actorRole: 'member'` +
 *     `actorMemberId` — the use-case refuses (403 forbidden + probe
 *     audit) if the invoice's member_id doesn't match the caller.
 *
 * Proxy kill-switch: `/api/portal/invoices` is already gated by
 * `src/proxy.ts` when FEATURE_F4_INVOICING=false.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMemberContext } from '@/lib/member-context';
import {
  getInvoicePdfSignedUrl,
  makeGetInvoicePdfSignedUrlDeps,
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

  // R8-L2-code — wrap the use-case call in try/catch parity. The
  // use-case now (R8-M1-code) emits `invoice_pdf_downloaded` on
  // success; if `audit.emit` throws (Neon transient, retention
  // constraint), surface as a 500 instead of letting the worker crash.
  let result: Awaited<ReturnType<typeof getInvoicePdfSignedUrl>>;
  try {
    result = await getInvoicePdfSignedUrl(
      makeGetInvoicePdfSignedUrlDeps(ctx.tenant.slug),
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
      'GET /api/portal/invoices/[id]/pdf — getInvoicePdfSignedUrl threw',
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
      },
      'GET /api/portal/invoices/[id]/pdf failed',
    );
    // T166-10 — async receipt PDF still rendering. 425 Too Early +
    // Retry-After (seconds) tells the portal page (and any well-
    // behaved client) to back off and re-poll. RFC 9110 §15.5.21
    // pairs naturally with Retry-After (RFC 9110 §10.2.3).
    if (result.error.code === 'receipt_pdf_pending') {
      return NextResponse.json(
        { error: { code: 'receipt_pdf_pending' } },
        {
          status: 425,
          headers: { 'Retry-After': String(result.error.retryAfterSeconds) },
        },
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

  // Server-side fetch — client never sees the Blob URL (R7-B1 pattern).
  let blobResponse: Response;
  try {
    blobResponse = await fetch(result.value.url);
  } catch (err) {
    logger.error(
      { requestId: ctx.requestId, invoiceId, err },
      'portal PDF — blob fetch failed',
    );
    return NextResponse.json(
      { error: { code: 'blob_fetch_failed' } },
      { status: 502 },
    );
  }
  if (!blobResponse.ok || !blobResponse.body) {
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
