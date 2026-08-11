/**
 * T080 — GET /api/credit-notes/[creditNoteId] (F4 / US6).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireApiPermission } from '@/lib/rbac';
import { mappedLegacy } from '@/modules/auth/domain/permissions/legacy-shim';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getCreditNote, makeGetCreditNoteDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { serialiseCreditNote } from '../_serialise';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ creditNoteId: string }> },
): Promise<NextResponse> {
  const ctx = await requireApiPermission(request, 'invoicing.read', mappedLegacy('credit_note', 'read'));
  if ('response' in ctx) return ctx.response;

  const { creditNoteId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // 016 T030 — narrow to the STAFF arm of the actor union (the gate already
  // denies members; the check keeps the type honest and fails loudly on a
  // gate bug instead of stamping a member as staff).
  const sessionRole = ctx.current.user.role;
  if (sessionRole === 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

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
        role: sessionRole,
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
