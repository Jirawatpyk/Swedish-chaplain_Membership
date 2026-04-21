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
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ creditNoteId: string }> },
): Promise<NextResponse> {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;
  const { creditNoteId } = await params;

  const result = await getCreditNotePdfSignedUrl(
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
  if (!result.ok) {
    logger.warn(
      {
        requestId: ctx.requestId,
        tenantId: ctx.tenant.slug,
        creditNoteId,
        errorCode: result.error.code,
      },
      'GET /api/portal/credit-notes/[id]/pdf failed',
    );
    const status =
      result.error.code === 'credit_note_not_found'
        ? 404
        : result.error.code === 'blob_missing'
          ? 502
          : 403;
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }

  // Server-side fetch — client never sees the Blob URL (R7-B1 pattern
  // mirrored from portal invoice PDF route).
  let blobResponse: Response;
  try {
    blobResponse = await fetch(result.value.url);
  } catch (err) {
    logger.error(
      { requestId: ctx.requestId, creditNoteId, err },
      'portal CN PDF — blob fetch failed',
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
  // RFC-5987 `filename*` carries the non-ASCII original (Thai doc
  // numbers never have non-ASCII in practice, but future
  // localisation is cheap insurance). `filename` fallback is ASCII-
  // safe for older clients.
  const asciiSafe = raw.replace(/["\\]/g, '_').replace(/[^\x20-\x7E]/g, '_');
  const contentDisposition = `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
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
