/**
 * T102 — POST /api/invoices/[invoiceId]/void (F4 / US5 Phase 9).
 *
 * Admin-only. Rate-limited 20/5min per (tenant, actor) — mirrors the
 * issue / pay / credit-note buckets. Maps typed `VoidInvoiceError`
 * codes to HTTP status.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  voidInvoice,
  voidInvoiceSchema,
  makeVoidInvoiceDeps,
  parseInvoiceId,
  type VoidInvoiceError,
} from '@/modules/invoicing';
import { serialiseInvoice, stripReason } from '../../_serialise';
import { logger } from '@/lib/logger';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/lib/auth-deps';

/**
 * HTTP-boundary schema — deliberately NARROWER than `voidInvoiceSchema`.
 *
 * The use-case schema also carries `requireStatus`, `suppressCancellationEmail`
 * and `supersededByInvoiceId`, which exist for the internal void-on-reissue
 * caller (`issueMembershipBill`) and are not part of this endpoint's contract.
 * Parsing the raw body against the use-case schema let a caller set them
 * directly: suppressing the FR-036 cancellation email the UI never offers to
 * skip, and writing a "superseded by" audit payload for a plain manual void.
 * Everything else in the use-case input is server-derived, so this schema
 * covers the entire client-supplied surface.
 */
const voidInvoiceBodySchema = z.object({
  voidReason: voidInvoiceSchema.shape.voidReason,
});

const ERROR_STATUS: Record<VoidInvoiceError['code'], number> = {
  invoice_not_found: 404,
  invalid_status: 409,
  concurrent_state_change: 409,
  settings_missing: 422,
  no_snapshot_on_invoice: 422,
  pdf_render_failed: 500,
  // 8A — a refund is in flight on this invoice. 409 Conflict: transient, the
  // admin retries once the refund settles.
  refund_in_progress: 409,
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
  // Validate the path param up front. The wide `voidInvoiceSchema` used to do
  // this as a side effect (its `invoiceId` is `z.string().uuid()`); narrowing
  // the body schema to close CWE-915 dropped that guard, so a malformed id
  // would otherwise reach `asInvoiceId` (an unchecked cast) → Postgres 22P02
  // → an opaque 500 instead of a clean 400 on this money-path route.
  const parsedInvoiceId = parseInvoiceId(invoiceId);
  if (!parsedInvoiceId.ok) {
    // Mirror zod's `.flatten()` shape used by the body-validation 400 below, so
    // a client always reads a field error the same way (`details.fieldErrors`)
    // regardless of which input failed.
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          details: { formErrors: [], fieldErrors: { invoiceId: ['invalid_invoice_id'] } },
        },
      },
      { status: 400 },
    );
  }

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

  const parsed = voidInvoiceBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid_body', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  // Server-derived identity is assembled here rather than spread over the
  // parsed body, so no client value can reach these fields (CWE-915) — most
  // importantly `actorUserId`, which lands in the audit event for a void,
  // and a void retires a §87 sequential number irreversibly.
  const result = await voidInvoice(makeVoidInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    invoiceId: parsedInvoiceId.value,
    voidReason: parsed.data.voidReason,
  });
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
