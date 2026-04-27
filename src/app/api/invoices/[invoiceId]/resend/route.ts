/**
 * T107 — POST /api/invoices/[invoiceId]/resend (admin / manager).
 *
 * Body: `{ variant: 'invoice' | 'receipt' }` (default 'invoice').
 *
 * Rate-limit: 1 resend per invoice per 5 min (FR / T107 spec).
 *   Key: `f4:resend:invoice:{tenantId}:{invoiceId}:{variant}`
 *   Per DOCUMENT (not per actor) — admin-and-member cannot mail-bomb
 *   the same invoice via a race between portals.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resendPdf, makeResendPdfDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';

const variantSchema = z
  .object({ variant: z.enum(['invoice', 'receipt']).default('invoice') })
  .default({ variant: 'invoice' });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'invoice',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — variant defaults to 'invoice'.
  }
  const parsed = variantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'validation_failed', issues: parsed.error.issues } },
      { status: 400 },
    );
  }
  const variant = parsed.data.variant;

  // Per-document rate-limit — 1 resend per 5 min.
  const rl = await rateLimiter.check(
    `f4:resend:invoice:${tenantCtx.slug}:${invoiceId}:${variant}`,
    1,
    300,
  );
  if (!rl.success) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        variant,
        reset: rl.reset,
      },
      'POST /api/invoices/[id]/resend rate-limited',
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
    kind: 'invoice',
    invoiceId,
    variant,
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
        invoiceId,
        variant,
        errorCode: result.error.code,
      },
      'POST /api/invoices/[id]/resend failed',
    );
    const status =
      result.error.code === 'not_found'
        ? 404
        : result.error.code === 'forbidden'
          ? 403
          : 409; // not_issued / no_receipt_pdf
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
