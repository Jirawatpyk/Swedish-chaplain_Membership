/**
 * 107-auto-invoice Task 14 — POST /api/invoices/[invoiceId]/discard-auto-draft.
 *
 * The admin review-queue's "Discard" row action. Deletes an
 * `origin='auto_renewal' status='draft'` invoice the treasurer has decided
 * NOT to issue. Admin-only (money-adjacent write on the `invoice` resource,
 * same `requireAdminContext` policy as `/issue-auto-drafted` and `/void`).
 *
 * Rate limit: 60/5min per (tenant, actor) — same figure and rationale as
 * the sibling `/issue-auto-drafted` route (see its module header): a
 * treasurer clearing a batch of stale/superseded drafts in one sitting is a
 * routine flow here too, not just on the issue side.
 *
 * No request body — nothing for the client to supply beyond the path id.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  discardAutoDraftedRenewal,
  makeDiscardAutoDraftedRenewalDeps,
  type DiscardAutoDraftedRenewalError,
} from '@/modules/renewals';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/lib/auth-deps';

const STATUS_BY_KIND: Readonly<Record<DiscardAutoDraftedRenewalError['kind'], number>> = {
  invalid_input: 400,
  // A concurrent Issue action promoted the row first — the same "the row
  // moved under you, refresh" shape the sibling `/issue` route's
  // `invoice_already_issued` gets (409), not a 404 (the id is real, its
  // state just changed).
  not_draft: 409,
  not_found: 404,
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'write' });
  if ('response' in ctx) return ctx.response;

  const { invoiceId } = await params;
  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  const rl = await rateLimiter.check(
    `f4:discard-auto-draft:${tenantCtx.slug}:${ctx.current.user.id}`,
    60,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/invoices/[id]/discard-auto-draft rate-limited',
    );
    return rateLimitedJson(rl);
  }

  const result = await discardAutoDraftedRenewal(
    makeDiscardAutoDraftedRenewalDeps(tenantCtx.slug),
    {
      tenantId: tenantCtx.slug,
      invoiceId,
      actorUserId: ctx.current.user.id,
      requestId,
    },
  );

  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        errorCode: result.error.kind,
      },
      'POST /api/invoices/[id]/discard-auto-draft failed',
    );
    return NextResponse.json(
      { error: { code: result.error.kind } },
      { status: STATUS_BY_KIND[result.error.kind] },
    );
  }

  // Observability (107 follow-up) — a treasurer discarded one auto-draft.
  renewalsMetrics.autoDraftDiscarded(tenantCtx.slug, 'manual');

  return NextResponse.json(
    {
      invoice_id: result.value.invoiceId,
      audit_emitted: result.value.auditEmitted,
    },
    { status: 200 },
  );
}
