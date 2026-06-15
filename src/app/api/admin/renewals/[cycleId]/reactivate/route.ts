/**
 * 070 F8 item #18 — POST `/api/admin/renewals/[cycleId]/reactivate`.
 *
 * Admin approves a cycle stuck in `pending_admin_reactivation` after a
 * payment landed against an admin-blocked auto-reactivation member
 * (FR-005b override). Transitions the cycle
 * `pending_admin_reactivation` → `completed`
 * (closed_reason='admin_reactivated'); audit emitted in-tx by the
 * use-case.
 *
 * Mirrors the cancel route (`[cycleId]/cancel/route.ts`):
 *   - `env.features.f8Renewals` kill-switch → 503
 *   - `requireRenewalAdminContext(request, 'write')` admin-only;
 *     manager → 403 + `f8_role_violation_blocked` audit
 *   - shared `errorResponse` / `successResponse` envelopes
 *
 * Body: confirmation-only (no schema fields). We still parse the JSON so a
 * malformed body is rejected with 400 `invalid_body`, but an EMPTY body is
 * accepted (the action is a pure confirmation).
 *
 * Outcome → HTTP mapping:
 *   - invalid_input   → 400
 *   - cycle_not_found → 404
 *   - cycle_not_pending → 409 (+ current_status)
 *   - server_error    → 500
 * Success 200 `{ cycle_status, closed_reason, closed_at }`.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import {
  adminReactivateLapsedCycle,
  makeRenewalsDeps,
} from '@/modules/renewals';

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

  const { cycleId } = await context.params;

  // Confirmation-only body. Reject malformed JSON (defence against a
  // broken client) but tolerate an empty body — no schema fields are
  // expected. A present-but-non-object body (e.g. `"x"`) is harmless;
  // we only fail on JSON the parser cannot read.
  const rawBody = await request.text();
  if (rawBody.trim().length > 0) {
    try {
      JSON.parse(rawBody);
    } catch {
      return errorResponse({
        status: 400,
        code: 'invalid_body',
        correlationId: ctx.correlationId,
      });
    }
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await adminReactivateLapsedCycle(deps, {
      tenantId: tenantCtx.slug,
      cycleId,
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
      'reactivate-lapsed-cycle route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
