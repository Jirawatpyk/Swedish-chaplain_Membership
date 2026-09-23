/**
 * G-1 Phase B — GET /api/portal/credit-notes/[creditNoteId]/pdf.
 *
 * Member-scope credit-note PDF download. Mirrors the admin CN PDF
 * route byte-streaming pattern and the portal invoice PDF route
 * ownership model: fetch bytes from Blob server-side, stream to
 * client with `Content-Disposition: attachment`. The Blob URL is
 * never exposed to the client.
 *
 * Access control (defence in depth):
 *   - `requireMemberContext` — resolves the member from the linked
 *     user id; returns 401/403/503 if the session is invalid, the
 *     user has no linked member, or F4 is disabled.
 *   - `getCreditNotePdfSignedUrl` with `actorRole: 'member'` +
 *     `actorMemberId` — the use-case refuses with `credit_note_not_found`
 *     (and emits `credit_note_cross_tenant_probe` audit) if the CN's
 *     original-invoice member_id does not match the caller.
 *
 * Proxy kill-switch: `/api/portal/**` is already gated by
 * `src/proxy.ts` when FEATURE_F4_INVOICING=false.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMemberContext } from '@/lib/member-context';
import {
  getCreditNotePdfSignedUrl,
  makeGetCreditNotePdfSignedUrlDeps,
} from '@/modules/invoicing';
import { streamPdfFromBlob } from '@/lib/stream-pdf-from-blob';
import { pdfRouteErrorStatus } from '@/lib/pdf-route-error-status';
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ creditNoteId: string }> },
): Promise<NextResponse> {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;
  const { creditNoteId } = await params;

  // Parity with the portal invoice PDF route: a throw from the use case (a
  // Blob outage, an audit-emit failure) answers a structured 500 instead of
  // escaping the handler.
  let result: Awaited<ReturnType<typeof getCreditNotePdfSignedUrl>>;
  try {
    result = await getCreditNotePdfSignedUrl(
      makeGetCreditNotePdfSignedUrlDeps(ctx.tenant.slug),
      {
        tenantId: ctx.tenant.slug,
        actorUserId: ctx.current.user.id,
        actorRole: 'member',
        actorMemberId: ctx.memberId,
        requestId: ctx.requestId,
        creditNoteId,
      },
    );
  } catch (err) {
    logger.error(
      { requestId: ctx.requestId, tenantId: ctx.tenant.slug, creditNoteId, err },
      'GET /api/portal/credit-notes/[id]/pdf — getCreditNotePdfSignedUrl threw',
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
        creditNoteId,
        errorCode: result.error.code,
        // The missing blob's key, so on-call can locate the orphaned object
        // without joining back to the credit-note row (runbook:
        // receipt-pdf-permanently-failed.md § Missing PDF blob).
        ...(result.error.code === 'blob_missing'
          ? { blobKey: result.error.key }
          : {}),
      },
      'GET /api/portal/credit-notes/[id]/pdf failed',
    );
    return NextResponse.json(
      { error: { code: result.error.code } },
      { status: pdfRouteErrorStatus(result.error.code) },
    );
  }

  return streamPdfFromBlob({
    url: result.value.url,
    filename: result.value.filename,
    logContext: { requestId: ctx.requestId, tenantId: ctx.tenant.slug, creditNoteId },
    route: '/api/portal/credit-notes/[id]/pdf',
  });
}
