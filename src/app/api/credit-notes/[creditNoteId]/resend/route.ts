/**
 * T107 — POST /api/credit-notes/[creditNoteId]/resend (admin / manager).
 *
 * Rate-limit: 1 resend per credit-note per 5 min.
 *   Key: `f4:resend:credit_note:{tenantId}:{creditNoteId}`
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resendPdf, makeResendPdfDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ creditNoteId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'credit_note',
    action: 'write',
  });
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
    return NextResponse.json(
      {
        error: {
          code: 'rate_limited',
          retryAfterMs: rl.reset - Date.now(),
        },
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(retryAfterSecondsFromRl(rl)),
        },
      },
    );
  }

  const result = await resendPdf(makeResendPdfDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    kind: 'credit_note',
    creditNoteId,
    actor: {
      userId: ctx.current.user.id,
      role: ctx.current.user.role as 'admin' | 'manager',
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
