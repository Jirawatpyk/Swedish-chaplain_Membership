/**
 * T066 — POST /api/invoices/[invoiceId]/pay.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { recordPayment, recordPaymentSchema, makeRecordPaymentDeps } from '@/modules/invoicing';
import { env } from '@/lib/env';
// PR #24 Round 6 — F8 callbacks are dynamically imported below ONLY when
// `FEATURE_F8_RENEWALS=true`. Previously this was a top-level static
// import which loaded the entire renewals barrel (~50-150ms cold-start
// + bundle pollution) on every F4 admin-pay request even when F8 was
// dark. The dynamic import path keeps F4 routes free of F8 module
// loading when the feature flag is off.
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

  // FR-023 — 20 payment-record attempts per (tenant, actor) per
  // 5 min. Mirrors the /issue bucket — the idempotent replay path
  // inside record-payment is the safety net for legitimate retries;
  // this cap throttles misbehaving clients before they reach it.
  const rl = await rateLimiter.check(
    `f4:pay:${tenantCtx.slug}:${ctx.current.user.id}`,
    20,
    300,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/invoices/[id]/pay rate-limited',
    );
    return rateLimitedJson(rl);
  }

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

  // Wire F8 cycle-completion callback when the renewals feature is on.
  // Without this, an admin marking a renewal invoice paid via this F4
  // route leaves the F8 RenewalCycle stuck in `awaiting_payment`. The
  // F8-specific mark-paid-offline route wires its own callback; this
  // is the catch-all for the legacy F4 path.
  //
  // Round 6 — dynamic import the renewals barrel ONLY when the feature
  // is on. Vercel Fluid Compute caches the import after first hit, so
  // F8-enabled tenants pay the load cost once per process, while
  // F4-only deploys never load the barrel at all.
  const f8Callbacks = env.features.f8Renewals
    ? (await import('@/modules/renewals')).f8OnPaidCallbacks(tenantCtx.slug)
    : undefined;
  const result = await recordPayment(
    makeRecordPaymentDeps(tenantCtx.slug, undefined, f8Callbacks),
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
      'POST /api/invoices/[id]/pay failed',
    );
    const status =
      result.error.code === 'invoice_not_found' ? 404
      : result.error.code === 'invalid_status' ? 409
      : result.error.code === 'concurrent_state_change' ? 409
      // REMOVE-WITH-064-REMEDIATION (site 3/7 — checklist at the guard in
      // record-payment.ts). 064 INTERIM — legacy issued no-TIN event row:
      // paying would mint a §105 receipt #2; conflicts with the row's
      // remediation state → 409.
      : result.error.code === 'legacy_no_tin_event_needs_remediation' ? 409
      : result.error.code === 'settings_missing' ? 409
      : result.error.code === 'no_snapshot_on_invoice' ? 422
      : result.error.code === 'overflow' ? 422
      : result.error.code === 'pdf_render_failed' ? 500
      : result.error.code === 'blob_upload_failed' ? 500
      : 422;
    return NextResponse.json({ error: stripReason(result.error) }, { status });
  }
  return NextResponse.json(serialiseInvoice(result.value));
}
