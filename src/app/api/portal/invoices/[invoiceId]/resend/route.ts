/**
 * T107 — POST /api/portal/invoices/[invoiceId]/resend (member self-service).
 *
 * Member-side "email me a copy" action. Shares the per-document
 * rate-limit key with the admin route, so the same 1-per-5-min window
 * applies whether the admin or the member triggered the resend.
 *
 * Variant: member-portal only resends the invoice PDF (not the
 * receipt) — receipts are a bookkeeping artefact the portal detail
 * page already links to via the download endpoint; separate "resend
 * receipt" self-service is deferred until we see demand.
 *
 * Proxy kill-switch: `/api/portal/invoices` is already gated by
 * `src/proxy.ts` when FEATURE_F4_INVOICING=false.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMemberContext } from '@/lib/member-context';
import { resendPdf, makeResendPdfDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/auth-deps';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  const { invoiceId } = await params;

  const rl = await rateLimiter.check(
    `f4:resend:invoice:${ctx.tenant.slug}:${invoiceId}:invoice`,
    1,
    300,
  );
  if (!rl.success) {
    logger.warn(
      {
        requestId: ctx.requestId,
        tenantId: ctx.tenant.slug,
        invoiceId,
        memberId: ctx.memberId,
        reset: rl.reset,
      },
      'POST /api/portal/invoices/[id]/resend rate-limited',
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
          'Retry-After': String(Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))),
        },
      },
    );
  }

  const result = await resendPdf(makeResendPdfDeps(ctx.tenant.slug), {
    tenantId: ctx.tenant.slug,
    kind: 'invoice',
    invoiceId,
    variant: 'invoice',
    actor: {
      userId: ctx.current.user.id,
      role: 'member',
      memberId: ctx.memberId,
      requestId: ctx.requestId,
    },
  });

  if (!result.ok) {
    logger.warn(
      {
        requestId: ctx.requestId,
        tenantId: ctx.tenant.slug,
        invoiceId,
        memberId: ctx.memberId,
        errorCode: result.error.code,
      },
      'POST /api/portal/invoices/[id]/resend failed',
    );
    // Member-side: opaque 404 on forbidden so member-to-member
    // enumeration is not possible via status-code probing. The
    // use-case already collapses the member-mismatch path onto
    // `not_found`, but defensively map forbidden→404 as well.
    const status =
      result.error.code === 'not_found' || result.error.code === 'forbidden'
        ? 404
        : 409;
    return NextResponse.json(
      {
        error: {
          code:
            result.error.code === 'forbidden' ? 'not_found' : result.error.code,
        },
      },
      { status },
    );
  }

  return NextResponse.json(
    { ok: true, recipientEmail: result.value.recipientEmail },
    { status: 202 },
  );
}
