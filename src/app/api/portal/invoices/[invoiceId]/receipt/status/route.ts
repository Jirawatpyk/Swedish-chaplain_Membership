/**
 * GET /api/portal/invoices/[invoiceId]/receipt/status — 088 T066a (FR-019).
 *
 * Lightweight poll endpoint behind `<ReceiptStatusWatcher>`. Returns ONLY the
 * async receipt-PDF render status (`pending | rendered | failed | null`) for the
 * OWNING member so the portal can auto-reveal the receipt download the moment
 * the async worker finishes — without a manual refresh.
 *
 * PII: the response body carries NOTHING but the status enum (no amounts, no
 * document numbers, no emails, no snapshot). Ownership + cross-tenant isolation
 * reuse `getInvoice` with the member actor — the SAME guard the portal detail
 * page + the receipt/pdf download route apply: a cross-tenant / non-owned /
 * missing invoice emits the probe audit inside the use-case and collapses to an
 * opaque 404 here (no enumeration signal).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireMemberContext } from '@/lib/member-context';
import { getInvoice, makeGetInvoiceDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;
  const { invoiceId } = await params;

  let result: Awaited<ReturnType<typeof getInvoice>>;
  try {
    result = await getInvoice(makeGetInvoiceDeps(ctx.tenant.slug), {
      tenantId: ctx.tenant.slug,
      invoiceId,
      actor: {
        userId: ctx.current.user.id,
        role: 'member',
        requestId: ctx.requestId,
        memberId: ctx.memberId,
      },
    });
  } catch (err) {
    logger.error(
      { requestId: ctx.requestId, tenantId: ctx.tenant.slug, invoiceId, err },
      'GET /api/portal/invoices/[id]/receipt/status — use-case threw',
    );
    return NextResponse.json({ error: { code: 'internal_error' } }, { status: 500 });
  }

  if (!result.ok) {
    // Opaque 404 — the use-case already emitted any cross-tenant / ownership
    // probe audit. No error-code differential a member could enumerate against.
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }

  return NextResponse.json(
    { status: result.value.receiptPdfStatus },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
