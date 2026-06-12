/**
 * Task 11 (064-event-invoice-paid-flow) — POST /api/invoices/[invoiceId]/issue-as-paid.
 *
 * One-shot draft→paid issuance for EVENT invoices whose payment already
 * happened out-of-band (door cash, confirmed bank transfer). Admin-only.
 * Allocates the §87 number, renders the ONE combined (TIN) or §105 receipt
 * (no-TIN, β) document, and persists the paid row atomically — see the
 * use-case header for the full contract.
 *
 * Raw throws (residual transient deadlocks + the 0213 unique-index 23505
 * backstop; the former member↔advisory AB-BA edge was resolved at the root
 * in wave-3 S12) deliberately propagate to Next's default 500 handler —
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
      logger.error(failureLog, 'POST /api/invoices/[id]/issue-as-paid failed');
    } else {
      logger.warn(failureLog, 'POST /api/invoices/[id]/issue-as-paid failed');
    }
    // Wave-4 S16 — shared issuance-route map; overrides carry ONLY the
    // codes this as-paid route can see: the event-subject guard and the
    // payment-date bounds (future + the wave-3 S10 >365-day typo-year
    // backdate — same 422 class).
    const status = issueErrorStatus(result.error.code, {
      not_event_subject: 422,
      payment_date_future: 422,
      payment_date_too_old: 422,
    });
    return NextResponse.json({ error: stripReason(result.error) }, { status });
  }
  return NextResponse.json(serialiseInvoice(result.value), { status: 200 });
}
