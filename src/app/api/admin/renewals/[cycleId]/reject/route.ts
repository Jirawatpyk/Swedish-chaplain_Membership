/**
 * 070 F8 item #18 — POST `/api/admin/renewals/[cycleId]/reject`.
 *
 * Admin rejects a cycle stuck in `pending_admin_reactivation` and issues
 * an F5 refund for the cycle's linked invoice (FR-005d). Transitions the
 * cycle `pending_admin_reactivation` → `cancelled`
 * (closed_reason='admin_rejected_with_refund'); audit + post-refund
 * finance escalation task emitted in-tx by the use-case.
 *
 * Money/refund endpoint → DEFENCE-IN-DEPTH rate-limit 30/5min per
 * (tenant, admin), applied AFTER the RBAC gate and BEFORE the refund
 * use-case (mirrors send-reminder-now's limiter + `retryAfterSecondsFromRl`).
 * Bounds accidental click-storms on an irreversible refund action.
 *
 * Body: `{ reason: string (trimmed, 1..500) }`.
 *
 * Outcome → HTTP mapping:
 *   - invalid_input        → 400
 *   - cycle_not_found      → 404
 *   - cycle_not_pending    → 409 (+ current_status)
 *   - refund_failed        → 502 (+ error_code, detail)
 *   - server_error         → 500
 * Success 200 `{ cycle_status, closed_reason, closed_at, refund_credit_note_id }`.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { adminRejectReactivation, makeRenewalsDeps } from '@/modules/renewals';

/**
 * 30 requests per 5 minutes per (tenant, admin). Generous for the
 * legitimate "reject + refund a handful of erroneously-paid
 * reactivations" workflow while bounding accidental double-clicks on a
 * money-moving endpoint.
 */
const RL_LIMIT = 30;
const RL_WINDOW_SECONDS = 300;

const BodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ cycleId: string }> },
) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'write');
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);

  // Defence-in-depth: rate-limit AFTER the RBAC gate, BEFORE any refund.
  const rl = await rateLimiter.check(
    `f8:reject-reactivation:${tenantCtx.slug}:${ctx.current.user.id}`,
    RL_LIMIT,
    RL_WINDOW_SECONDS,
  );
  if (!rl.success) {
    return errorResponse({
      status: 429,
      code: 'rate_limited',
      correlationId: ctx.correlationId,
      headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) },
    });
  }

  const { cycleId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
    });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await adminRejectReactivation(deps, {
      tenantId: tenantCtx.slug,
      cycleId,
      reason: parsed.data.reason,
      actorUserId: ctx.current.user.id,
      actorRole: 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });

    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId: ctx.correlationId,
            details: { message: result.error.message },
          });
        case 'cycle_not_found':
          return errorResponse({
            status: 404,
            code: 'cycle_not_found',
            correlationId: ctx.correlationId,
          });
        case 'cycle_not_pending':
          return errorResponse({
            status: 409,
            code: 'cycle_not_pending',
            correlationId: ctx.correlationId,
            details: { current_status: result.error.currentStatus },
          });
        case 'refund_failed':
          // 502 Bad Gateway: the downstream payment processor (Stripe via
          // F5) failed. The cycle stays `pending_admin_reactivation` — the
          // admin can retry. error_code/detail surface the F5 failure
          // category to the UI without leaking internals.
          return errorResponse({
            status: 502,
            code: 'refund_failed',
            correlationId: ctx.correlationId,
            details: {
              error_code: result.error.errorCode,
              detail: result.error.detail,
            },
          });
        case 'server_error':
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        default: {
          const _exhaustive: never = result.error;
          void _exhaustive;
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        }
      }
    }

    return successResponse(
      {
        cycle_status: result.value.cycleStatus,
        closed_reason: result.value.closedReason,
        closed_at: result.value.closedAt,
        refund_credit_note_id: result.value.refundCreditNoteId,
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        cycleId,
        tenantId: tenantCtx.slug,
      },
      'reject-reactivation route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
