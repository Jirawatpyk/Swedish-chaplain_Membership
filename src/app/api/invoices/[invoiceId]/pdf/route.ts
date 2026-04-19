/**
 * T055 — GET /api/invoices/[invoiceId]/pdf — redirect to signed URL.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getInvoicePdfSignedUrl, makeGetInvoicePdfSignedUrlDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';

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
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        errorCode: result.error.code,
      },
      'GET /api/invoices/[id]/pdf failed',
    );
    const status = result.error.code === 'invoice_not_found' ? 404 : 403;
    return NextResponse.json({ error: { code: result.error.code } }, { status });
  }
  const response = NextResponse.redirect(result.value.url, { status: 307 });
  // RFC 6266-compliant Content-Disposition — quote the ASCII fallback
  // AND emit filename* with percent-encoded UTF-8 so Thai / space /
  // non-ASCII characters survive cross-browser. Note: browsers often
  // honor the Content-Disposition on the REDIRECT TARGET (Vercel
  // Blob) instead of this response — the Blob upload must also set
  // it. See adapters/vercel-blob-adapter.ts for the upload side.
  const raw = result.value.filename;
  const asciiSafe = raw.replace(/["\\]/g, '_').replace(/[^\x20-\x7E]/g, '_');
  response.headers.set(
    'Content-Disposition',
    `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(raw)}`,
  );
  return response;
}
