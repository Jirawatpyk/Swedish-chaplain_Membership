/**
 * T107 — POST /api/credit-notes/[creditNoteId]/resend (admin / manager).
 *
 * Rate-limit: 1 resend per credit-note per 5 min.
 *   Key: `f4:resend:credit_note:{tenantId}:{creditNoteId}`
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resendPdf, makeResendPdfDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/auth-deps';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ creditNoteId: string }> },
): Promise<NextResponse> {
  const ctx = await requireApiPermission(request, 'credit_notes.write');
  if ('response' in ctx) return ctx.response;

  const { creditNoteId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  const rl = await rateLimiter.check(
    `f4:resend:credit_note:${tenantCtx.slug}:${creditNoteId}`,
    1,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, creditNoteId, reset: rl.reset },
      'POST /api/credit-notes/[id]/resend rate-limited',
    );
    return rateLimitedJson(rl);
  }

  // 016 T030 — narrow to the STAFF arm of the actor union (the gate already
  // denies members).
  const sessionRole = ctx.current.user.role;
  // rbac-portal-identity-ok: staff-vs-member split for the response shape; staff authority is the gate above.
  if (sessionRole === 'member') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const result = await resendPdf(makeResendPdfDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    kind: 'credit_note',
    creditNoteId,
    actor: {
      userId: ctx.current.user.id,
      role: sessionRole,
      requestId,
    },
  });

  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        creditNoteId,
        errorCode: result.error.code,
      },
      'POST /api/credit-notes/[id]/resend failed',
    );
    // 409 covers not_issued / no_receipt_pdf and, since 108, no_recipient —
    // the member has no live primary contact, so there is nothing to resend to.
    const status = result.error.code === 'not_found' ? 404 : 409;
    return NextResponse.json(
      { error: { code: result.error.code } },
      { status },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      documentNumber: result.value.documentNumber,
      recipientEmail: result.value.recipientEmail,
    },
    { status: 202 },
  );
}
