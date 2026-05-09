/**
 * F8 Phase 7 T193 — `GET /api/admin/renewals/tier-upgrades`.
 *
 * Returns the admin queue of tier-upgrade suggestions in `open` OR
 * `accepted_pending_apply` state for the current tenant. Admin role
 * required (manager + member denied via route-helper).
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
import { makeRenewalsDeps } from '@/modules/renewals';

export async function GET(request: NextRequest) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'read');
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const cursorParam = url.searchParams.get('cursor');
  const limit = limitParam !== null ? Number.parseInt(limitParam, 10) : 50;

  try {
    const queue = await deps.tierUpgradeRepo.listForAdminQueue(
      tenantCtx.slug,
      {
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(cursorParam !== null ? { cursor: cursorParam } : {}),
      },
    );
    return successResponse(
      {
        items: queue.items.map((s) => ({
          suggestion_id: s.suggestionId,
          member_id: s.memberId,
          status: s.status,
          from_plan_id: s.fromPlanId,
          to_plan_id: s.toPlanId,
          reason_code: s.reasonCode,
          evidence: s.evidence,
          created_at: s.createdAt,
          accepted_at: s.acceptedAt ?? null,
          target_apply_at_cycle_id: s.targetApplyAtCycleId ?? null,
        })),
        next_cursor: queue.nextCursor,
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
      },
      'admin.renewals.tier-upgrades.list_unexpected_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
