/**
 * F8 Phase 7 T194 — `POST /api/admin/renewals/tier-upgrades/[suggestionId]/accept`.
 *
 * Admin Accept transitions suggestion `open` → `accepted_pending_apply`,
 * schedules the F2 plan change at next cycle rollover, optionally
 * creates a T-180 verification task, and emits the audit trail.
 *
 * RBAC: admin only.
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
import { acceptTierUpgrade, makeRenewalsDeps } from '@/modules/renewals';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ suggestionId: string }> },
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

  const { suggestionId } = await context.params;
  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await acceptTierUpgrade(deps, {
      tenantId: tenantCtx.slug,
      suggestionId,
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
        case 'suggestion_not_found':
          return errorResponse({
            status: 404,
            code: 'suggestion_not_found',
            correlationId: ctx.correlationId,
          });
        case 'suggestion_not_open':
          return errorResponse({
            status: 409,
            code: 'suggestion_not_open',
            correlationId: ctx.correlationId,
          });
        case 'no_active_cycle':
          return errorResponse({
            status: 409,
            code: 'no_active_cycle',
            correlationId: ctx.correlationId,
          });
        case 'plan_change_failed':
          return errorResponse({
            status: 502,
            code: 'plan_change_failed',
            correlationId: ctx.correlationId,
            details: { message: result.error.message },
          });
        case 'server_error':
          // R4-C2 — surface the typed server_error message + errorId
          // so SRE alert routing keyed on `F8.ACCEPT_TIER.*` can match
          // the discriminator. Without this emit, the
          // `deploy-skew:unhandled-gateway-arm:*` message inserted by
          // R3-S5 never reaches Sentry/Grafana.
          logger.error(
            {
              errorId: 'F8.ACCEPT_TIER.SERVER_ERROR',
              correlationId: ctx.correlationId,
              suggestionId,
              message: result.error.message,
            },
            'admin.renewals.tier-upgrades.accept_server_error',
          );
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
      }
      const _exhaustive: never = result.error;
      return _exhaustive;
    }
    return successResponse(
      {
        suggestion_id: result.value.suggestionId,
        target_apply_at_cycle_id: result.value.targetApplyAtCycleId,
        verification_task_id: result.value.verificationTaskId,
        scheduled_change_id: result.value.scheduledChangeId,
      },
      ctx.correlationId,
    );
  } catch (e) {
    // R4-I4 — attach errorId so the F8 alert rule keyed on
    // `errorId: 'F8.ACCEPT_TIER.*'` actually catches uncaught throws.
    // R3-C3 pre-tx wrap blocks the documented escape paths, but
    // defence-in-depth: any future async-arm regression still emits
    // a routable signal.
    logger.error(
      {
        errorId: 'F8.ACCEPT_TIER.UNEXPECTED',
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        suggestionId,
      },
      'admin.renewals.tier-upgrades.accept_unexpected_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
