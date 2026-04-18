/**
 * T066 — POST /api/invoices/[invoiceId]/pay.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { recordPayment, recordPaymentSchema, makeRecordPaymentDeps } from '@/modules/invoicing';
import { serialiseInvoice } from '../../_serialise';

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
    const status =
      result.error.code === 'invoice_not_found' ? 404
      : result.error.code === 'invalid_status' ? 409
      : 422;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(serialiseInvoice(result.value));
}
