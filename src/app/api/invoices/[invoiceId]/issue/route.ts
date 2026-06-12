/**
 * T054 — POST /api/invoices/[invoiceId]/issue.
 *
 * Rate limit: 20 per (tenant, actor) per 5 minutes — applied via a
 * per-request Upstash token bucket if configured, otherwise a soft
 * guard. F1 + F3 pattern. For MVP we accept a best-effort rate-limit
 * using the existing Upstash `generic` token bucket via the F1 auth
 * module's rate-limit adapter — skipped here if unavailable.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { issueInvoice, issueInvoiceSchema, makeIssueInvoiceDeps } from '@/modules/invoicing';
import {
  isIssuanceServerFault,
  issueErrorStatus,
  serialiseInvoice,
  stripReason,
} from '../../_serialise';
import { logger } from '@/lib/logger';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/lib/auth-deps';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'write' });
  if ('response' in ctx) return ctx.response;

  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // FR-022 — 20 issuance attempts per (tenant, actor) per 5 min.
  // Prevents a runaway script from burning through the §87 sequence
  // numbers on valid drafts; legitimate admins rarely issue >20
  // invoices in 5 minutes.
  const rl = await rateLimiter.check(
    `f4:issue:${tenantCtx.slug}:${ctx.current.user.id}`,
    20,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/invoices/[id]/issue rate-limited',
    );
    return rateLimitedJson(rl);
  }

  const parsed = issueInvoiceSchema.safeParse({
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    invoiceId,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'invalid' } }, { status: 400 });
  }

  const result = await issueInvoice(makeIssueInvoiceDeps(tenantCtx.slug), parsed.data);
  if (!result.ok) {
    // 065 M-4 — severity split mirrors the use-case catch: overflow /
    // pdf_render_failed / blob_upload_failed are 500-class server faults
    // (ERROR, ops-alertable); business rejects stay WARN.
    const failureLog = {
      requestId,
      tenantId: tenantCtx.slug,
      invoiceId,
      errorCode: result.error.code,
    };
    if (isIssuanceServerFault(result.error.code)) {
      logger.error(failureLog, 'POST /api/invoices/[id]/issue failed');
    } else {
      logger.warn(failureLog, 'POST /api/invoices/[id]/issue failed');
    }
    // Wave-4 S16 — shared issuance-route map; overrides carry ONLY the
    // codes this plain-issue route can see. 066 removed the membership
    // tax_id_required gate, leaving the event no-TIN bill-first guard.
    const status = issueErrorStatus(result.error.code, {
      event_no_tin_requires_paid_issue: 422,
    });
    return NextResponse.json({ error: stripReason(result.error) }, { status });
  }
  return NextResponse.json(serialiseInvoice(result.value), { status: 200 });
}
