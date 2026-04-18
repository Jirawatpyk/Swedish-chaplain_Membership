/**
 * T052 — GET /api/invoices/[invoiceId] (detail) + DELETE (draft only).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  deleteInvoiceDraft,
  getInvoice,
  makeDeleteInvoiceDraftDeps,
  makeGetInvoiceDeps,
} from '@/modules/invoicing';
import { serialiseInvoice } from '../_serialise';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'read' });
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const result = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  return NextResponse.json(serialiseInvoice(result.value));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'delete' });
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);
  const result = await deleteInvoiceDraft(makeDeleteInvoiceDraftDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    invoiceId,
  });
  if (!result.ok) {
    const status = result.error.code === 'invoice_not_found' ? 404 : 409;
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }
  return new NextResponse(null, { status: 204 });
}
