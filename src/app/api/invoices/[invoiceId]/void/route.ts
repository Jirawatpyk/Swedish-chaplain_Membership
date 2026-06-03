/**
 * T102 — POST /api/invoices/[invoiceId]/void (F4 / US5 Phase 9).
 *
 * Admin-only. Rate-limited 20/5min per (tenant, actor) — mirrors the
 * issue / pay / credit-note buckets. Maps typed `VoidInvoiceError`
 * codes to HTTP status.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  voidInvoice,
  voidInvoiceSchema,
  makeVoidInvoiceDeps,
  type VoidInvoiceError,
} from '@/modules/invoicing';
import { serialiseInvoice, stripReason } from '../../_serialise';
import { logger } from '@/lib/logger';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/lib/auth-deps';

const ERROR_STATUS: Record<VoidInvoiceError['code'], number> = {
  invoice_not_found: 404,
  invalid_status: 409,
  concurrent_state_change: 409,
  settings_missing: 422,
  no_snapshot_on_invoice: 422,
  pdf_render_failed: 500,
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'write' });
  if ('response' in ctx) return ctx.response;
  // Manager role is read-only on finance per Constitution.
  if (ctx.current.user.role !== 'admin') {
    return NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 });
  }

  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  const rl = await rateLimiter.check(
    `f4:void:${tenantCtx.slug}:${ctx.current.user.id}`,
    20,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/invoices/[id]/void rate-limited',
    );
    return rateLimitedJson(rl);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'invalid_json' } }, { status: 400 });
  }

  const parsed = voidInvoiceSchema.safeParse({
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    invoiceId,
    ...((body as Record<string, unknown>) ?? {}),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid_body', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  const result = await voidInvoice(makeVoidInvoiceDeps(tenantCtx.slug), parsed.data);
  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        errorCode: result.error.code,
      },
      'POST /api/invoices/[id]/void failed',
    );
    const status = ERROR_STATUS[result.error.code] ?? 422;
    return NextResponse.json({ error: stripReason(result.error) }, { status });
  }
  return NextResponse.json(serialiseInvoice(result.value));
}
