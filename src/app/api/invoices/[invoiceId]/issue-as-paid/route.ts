/**
 * Task 11 (064-event-invoice-paid-flow) — POST /api/invoices/[invoiceId]/issue-as-paid.
 *
 * One-shot draft→paid issuance for EVENT invoices whose payment already
 * happened out-of-band (door cash, confirmed bank transfer). Admin-only.
 * Allocates the §87 number, renders the ONE combined (TIN) or §105 receipt
 * (no-TIN, β) document, and persists the paid row atomically — see the
 * use-case header for the full contract.
 *
 * Raw throws (the documented benign 40P01 AB-BA edge + the 0213 unique-index
 * 23505 backstop) deliberately propagate to Next's default 500 handler —
 * sibling parity with /issue, /pay and /event-draft, none of which wrap the
 * use-case call. Next's production handler returns a generic 500 without the
 * error message, so no `err.message` passthrough occurs at this layer either.
 * Typed errors are stripped of `reason` via stripReason before serialising.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  issueEventInvoiceAsPaid,
  issueEventInvoiceAsPaidSchema,
  makeIssueEventInvoiceAsPaidDeps,
} from '@/modules/invoicing';
import { env } from '@/lib/env';
// F8 callbacks are dynamically imported below ONLY when
// `FEATURE_F8_RENEWALS=true` — pay-route Round-6 parity: a top-level static
// import would load the entire renewals barrel (~50-150ms cold-start +
// bundle pollution) on every request even when F8 is dark.
import { serialiseInvoice, stripReason } from '../../_serialise';
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

  // 20 as-paid issuance attempts per (tenant, actor) per 5 min — same
  // §87-burn rationale as /issue: prevents a runaway script from burning
  // through the sequence numbers (invoice stream for TIN buyers, receipt
  // stream for no-TIN) on valid drafts; legitimate admins rarely issue >20
  // documents in 5 minutes.
  const rl = await rateLimiter.check(
    `f4:issue-as-paid:${tenantCtx.slug}:${ctx.current.user.id}`,
    20,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/invoices/[id]/issue-as-paid rate-limited',
    );
    return rateLimitedJson(rl);
  }

  // Body is OPTIONAL except paymentDate; a non-JSON body degrades to null and
  // fails schema validation on the missing paymentDate (single 400 path).
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const parsed = issueEventInvoiceAsPaidSchema.safeParse({
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    invoiceId,
    paymentDate: body?.paymentDate,
    // Default mirrors mark-paid-from-processor: an out-of-band payment with
    // no stated method is recorded as 'other' (CHECK invoices_paid_has_payment
    // forces payment_method NOT NULL on every paid row).
    paymentMethod: body?.paymentMethod ?? 'other',
    paymentReference: body?.paymentReference ?? null,
    paymentNotes: body?.paymentNotes ?? null,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'invalid' } }, { status: 400 });
  }

  // F8 parity (design panel L-1): a matched-member as-paid issuance fires the
  // same F4InvoicePaidEvent hooks recordPayment fires — without this, an
  // admin recording an out-of-band event payment for a member leaves any
  // correlated F8 state stale. Dynamic import keeps F4-only deploys free of
  // the renewals barrel (pay-route pattern).
  const f8Callbacks = env.features.f8Renewals
    ? (await import('@/modules/renewals')).f8OnPaidCallbacks(tenantCtx.slug)
    : undefined;

  const result = await issueEventInvoiceAsPaid(
    makeIssueEventInvoiceAsPaidDeps(tenantCtx.slug, f8Callbacks),
    parsed.data,
  );
  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        invoiceId,
        errorCode: result.error.code,
      },
      'POST /api/invoices/[id]/issue-as-paid failed',
    );
    const status =
      result.error.code === 'invoice_not_found' ? 404
      : result.error.code === 'member_not_found' ? 404
      : result.error.code === 'invoice_already_issued' ? 409
      : result.error.code === 'member_archived' ? 409
      : result.error.code === 'settings_missing' ? 409
      : result.error.code === 'not_event_subject' ? 422
      : result.error.code === 'payment_date_future' ? 422
      // Wave-3 S10 — >365-day backdate (typo-year guard); same 422 class
      // as the future bound.
      : result.error.code === 'payment_date_too_old' ? 422
      // 064 S1 — registration refunded between draft and as-paid issuance
      // (TOCTOU re-check): unprocessable business state, mirrors the
      // event-draft route's 422 for the same code. Lookup failure is an
      // internal verification error → 500 (default arm).
      : result.error.code === 'registration_refunded' ? 422
      : result.error.code === 'invalid_lines' ? 422
      : result.error.code === 'overflow' ? 422
      : result.error.code === 'no_buyer_snapshot' ? 422
      : result.error.code === 'pdf_render_failed' ? 500
      : result.error.code === 'blob_upload_failed' ? 500
      : 500;
    return NextResponse.json({ error: stripReason(result.error) }, { status });
  }
  return NextResponse.json(serialiseInvoice(result.value), { status: 200 });
}
