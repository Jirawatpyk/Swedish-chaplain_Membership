/**
 * T055 — GET /api/invoices/[invoiceId]/pdf — redirect to signed URL.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getInvoicePdfSignedUrl, makeGetInvoicePdfSignedUrlDeps } from '@/modules/invoicing';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'read' });
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  const result = await getInvoicePdfSignedUrl(
    makeGetInvoicePdfSignedUrlDeps(tenantCtx.slug),
    {
      tenantId: tenantCtx.slug,
      actorUserId: ctx.current.user.id,
      actorRole: ctx.current.user.role,
      requestId,
      invoiceId,
    },
  );
  if (!result.ok) {
    const status = result.error.code === 'invoice_not_found' ? 404 : 403;
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }
  const response = NextResponse.redirect(result.value.url, { status: 307 });
  response.headers.set(
    'Content-Disposition',
    `attachment; filename=${result.value.filename}`,
  );
  return response;
}
