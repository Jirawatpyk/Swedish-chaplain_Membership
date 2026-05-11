/**
 * F8 Phase 7 T193 — `GET /api/admin/renewals/tier-upgrades`.
 *
 * Returns the admin queue of tier-upgrade suggestions in `open` OR
 * `accepted_pending_apply` state for the current tenant. Admin role
 * required (manager + member denied — Round 6 W-003 closed the
 * manager-can-read-via-API gap; UI page already redirects manager).
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

// Round 6 W-005 — defence-in-depth cap on the `?limit=` query param.
// Mirrors the page server-component default of 50; the explicit upper
// bound prevents `?limit=999999` full-table scans even though RLS
// already scopes the rows. Must stay in sync with
// `tierUpgradeRepo.listForAdminQueue` cursor pagination internals.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export async function GET(request: NextRequest) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  // Round 6 W-003 — pass `'write'` to require admin role at the
  // RBAC layer. The `'read'` action permitted manager too (FR-052a
  // §F context says queue is admin-only — the explicit role gate
  // closes the API-layer bypass that the UI page redirect alone did
  // not catch).
  const ctx = await requireRenewalAdminContext(request, 'write');
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);
  const url = new URL(request.url);
  const limitParam = url.searchParams.get('limit');
  const cursorParam = url.searchParams.get('cursor');
  // Round 6 W-005 + W-006 — defensive parse with NaN guard + upper cap.
  // `Number.parseInt('abc', 10) === NaN` would throw at Drizzle's
  // `.limit(NaN)`; clamp to [1, MAX_LIMIT].
  const rawLimit =
    limitParam !== null ? Number.parseInt(limitParam, 10) : DEFAULT_LIMIT;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  try {
    const queue = await deps.tierUpgradeRepo.listForAdminQueue(
      tenantCtx.slug,
      {
        limit,
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
