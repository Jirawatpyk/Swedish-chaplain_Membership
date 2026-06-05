/**
 * Task 12 (054-event-fee-invoices) — POST /api/invoices/event-draft
 *
 * HTTP boundary for the event-fee invoice draft creation form.
 * Admin-only (manager/member → 403 via requireAdminContext).
 *
 * Feature-flag: FEATURE_F4_INVOICING=false → 503 via proxy.ts
 * (the `/api/invoices` prefix is already covered by the F4 kill-switch
 * in proxy.ts; no per-route check is needed here).
 *
 * Rate limit: 20 per (tenant, actor) per 5 minutes — same cadence as
 * the membership draft-create and issue routes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  createEventInvoiceDraft,
  createEventInvoiceDraftSchema,
  makeCreateEventInvoiceDraftDeps,
} from '@/modules/invoicing';
import { serialiseInvoice, stripReason } from '../_serialise';
import { logger } from '@/lib/logger';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { rateLimiter } from '@/lib/auth-deps';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, { resource: 'invoice', action: 'write' });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // 20 event-draft attempts per (tenant, actor) per 5 min.
  const rl = await rateLimiter.check(
    `f4:event-draft:${tenantCtx.slug}:${ctx.current.user.id}`,
    20,
    300,
  );
  if (!rl.success) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        userId: ctx.current.user.id,
        reset: rl.reset,
      },
      'POST /api/invoices/event-draft rate-limited',
    );
    return rateLimitedJson(rl);
  }

  // Parse + validate the JSON body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'invalid_json' } }, { status: 400 });
  }

  // Defense-in-depth: parse the body against the use-case schema.
  // This enforces amountOverride bounds + uuid format + buyer shape at
  // the HTTP boundary, giving callers a typed 400 before touching the DB.
  const parsed = createEventInvoiceDraftSchema.safeParse({
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    ...(body as Record<string, unknown>),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'invalid_body', details: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  const result = await createEventInvoiceDraft(
    makeCreateEventInvoiceDraftDeps(tenantCtx.slug),
    parsed.data,
  );

  if (!result.ok) {
    logger.warn(
      {
        requestId,
        tenantId: tenantCtx.slug,
        // Log the registration id (not-a-PII key); NO buyer fields.
        eventRegistrationId: parsed.data.eventRegistrationId,
        errorCode: result.error.code,
      },
      'POST /api/invoices/event-draft failed',
    );

    // Error-code → HTTP status mapping
    const status =
      result.error.code === 'registration_not_found' ? 404
      : result.error.code === 'event_not_found' ? 404
      : result.error.code === 'member_archived' ? 422
      : result.error.code === 'attendee_erased' ? 422
      : result.error.code === 'no_fee_free_event' ? 422
      : result.error.code === 'invalid_amount' ? 422
      : result.error.code === 'buyer_required' ? 422
      : result.error.code === 'invalid_tax_id_format' ? 422
      : result.error.code === 'invalid_buyer_snapshot' ? 422
      : result.error.code === 'duplicate' ? 409
      : result.error.code === 'lookup_failed' ? 500
      : 500;

    return NextResponse.json({ error: stripReason(result.error) }, { status });
  }

  return NextResponse.json(serialiseInvoice(result.value), { status: 201 });
}
