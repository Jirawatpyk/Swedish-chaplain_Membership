/**
 * T053 — GET /api/invoices/[invoiceId]/preview — watermarked PDF stream (FR-001a).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { previewInvoiceDraft, makePreviewInvoiceDraftDeps } from '@/modules/invoicing';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'write' });
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const result = await previewInvoiceDraft(makePreviewInvoiceDraftDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
    // R7-W1 — actor context enables `invoice_cross_tenant_probe`
    // audit emission when the draft lookup returns null.
    actorUserId: ctx.current.user.id,
    requestId: ctx.requestId,
  });
  if (!result.ok) {
    const status = result.error.code === 'invoice_not_found' ? 404 : 409;
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }
  return new NextResponse(Buffer.from(result.value.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename=preview-${invoiceId}.pdf`,
      'Cache-Control': 'no-store',
    },
  });
}
