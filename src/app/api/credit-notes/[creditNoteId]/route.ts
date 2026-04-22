/**
 * T080 — GET /api/credit-notes/[creditNoteId] (F4 / US6).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getCreditNote, makeGetCreditNoteDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { serialiseCreditNote } from '../_serialise';

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

  // Wrap the whole use-case + serialisation path: the repo's
  // row→domain mapping can throw on corrupt `document_number` /
  // `pdf_sha256` / VAT-balance violations. Without this catch the
  // throw escapes Result handling and surfaces as an unlogged 500.
  try {
    const result = await getCreditNote(makeGetCreditNoteDeps(tenantCtx.slug), {
      tenantId: tenantCtx.slug,
      creditNoteId,
      actor: {
        userId: ctx.current.user.id,
        role: ctx.current.user.role as 'admin' | 'manager',
        requestId,
      },
    });
    if (!result.ok) {
      logger.warn(
        { requestId, tenantId: tenantCtx.slug, creditNoteId, errorCode: result.error.code },
        'GET /api/credit-notes/[id] failed',
      );
      return NextResponse.json(
        { error: { code: result.error.code } },
        { status: result.error.code === 'not_found' ? 404 : 500 },
      );
    }
    return NextResponse.json(serialiseCreditNote(result.value));
  } catch (err) {
    logger.error(
      { requestId, tenantId: tenantCtx.slug, creditNoteId, err: String(err) },
      'GET /api/credit-notes/[id] — unexpected error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }
}
