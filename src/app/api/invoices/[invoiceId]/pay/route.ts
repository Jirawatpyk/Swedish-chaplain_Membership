/**
 * T066 — POST /api/invoices/[invoiceId]/pay.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { recordPayment, recordPaymentSchema, makeRecordPaymentDeps } from '@/modules/invoicing';
import { serialiseInvoice, stripReason } from '../../_serialise';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'write' });
  if ('response' in ctx) return ctx.response;

  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'invalid_json' } }, { status: 400 });
  }

  const parsed = recordPaymentSchema.safeParse({
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

  const result = await recordPayment(makeRecordPaymentDeps(tenantCtx.slug), parsed.data);
  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        errorCode: result.error.code,
      },
      'POST /api/invoices/[id]/pay failed',
    );
    const status =
      result.error.code === 'invoice_not_found' ? 404
      : result.error.code === 'invalid_status' ? 409
      : result.error.code === 'concurrent_state_change' ? 409
      : result.error.code === 'settings_missing' ? 409
      : result.error.code === 'no_snapshot_on_invoice' ? 422
      : result.error.code === 'overflow' ? 422
      : result.error.code === 'pdf_render_failed' ? 500
      : result.error.code === 'blob_upload_failed' ? 500
      : 422;
    return NextResponse.json({ error: stripReason(result.error) }, { status });
  }
  return NextResponse.json(serialiseInvoice(result.value));
}
