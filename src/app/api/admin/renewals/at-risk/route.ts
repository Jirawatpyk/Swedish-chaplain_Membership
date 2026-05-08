/**
 * F8 Phase 6 Wave D · T163 — `GET /api/admin/renewals/at-risk`.
 *
 * Returns a paginated list of at-risk members for the admin widget on
 * `/admin/renewals` per `contracts/admin-renewals-api.md` § 3. Filters:
 *   - `risk_score >= 50` (warning / at-risk / critical bands surface;
 *     healthy band hidden)
 *   - `risk_snoozed_until IS NULL OR risk_snoozed_until < NOW()`
 *
 * Optional query params:
 *   - `band` — narrow to a single band (warning | at-risk | critical)
 *   - `cursor` — opaque (server-encoded `${score}|${memberId}`)
 *   - `limit` — 1..50; default 20
 *
 * RBAC: admin OR manager (FR-052a — manager has full read on F8 admin
 * surfaces). `member` role 403 + emits `f8_role_violation_blocked`
 * audit (handled by the helper).
 *
 * Kill-switches: `FEATURE_F8_RENEWALS=false` returns 503; the granular
 * `FEATURE_F8_AT_RISK_DISABLED=true` returns 200 with an empty payload
 * + `feature_disabled: true` field so the UI can render the
 * "temporarily unavailable" placeholder per FR-052b.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
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

  // FR-052b granular kill-switch — return 200 with placeholder shape so
  // the widget UI renders "feature temporarily unavailable" without a
  // hard error state. Distinct from FEATURE_F8_RENEWALS=false (whole
  // F8 dark) which returns 503.
  if (env.features.f8AtRiskDisabled) {
    return successResponse(
      {
        items: [],
        next_cursor: null,
        summary: {
          warning: 0,
          'at-risk': 0,
          critical: 0,
          f6_active: false,
          active_max: 70,
        },
        feature_disabled: true,
      },
      ctx.correlationId,
    );
  }

  const url = new URL(request.url);
  const bandRaw = url.searchParams.get('band');
  const cursor = url.searchParams.get('cursor');
  const limitRaw = url.searchParams.get('limit');
  const limit =
    limitRaw !== null && Number.isFinite(Number(limitRaw))
      ? Math.min(50, Math.max(1, Number(limitRaw)))
      : 20;

  let band: 'warning' | 'at-risk' | 'critical' | undefined;
  if (bandRaw === 'warning' || bandRaw === 'at-risk' || bandRaw === 'critical') {
    band = bandRaw;
  } else if (bandRaw !== null) {
    return errorResponse({
      status: 400,
      code: 'invalid_band',
      correlationId: ctx.correlationId,
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const page = await runInTenant(tenantCtx, async (tx) => {
      return await deps.memberRenewalFlagsRepo.listAtRiskWidgetMembers(
        tx,
        tenantCtx.slug,
        {
          ...(band !== undefined ? { band } : {}),
          cursor,
          limit,
        },
      );
    });

    // F6 readiness — gate from the EventAttendees stub for now (Wave C
    // adapter swap when F6 ships will flip this signal).
    const f6Active = deps.eventAttendees.isAvailable();
    const activeMax = f6Active ? 100 : 70;

    return successResponse(
      {
        items: page.items.map((m) => ({
          member_id: m.memberId,
          company_name: m.companyName,
          risk_score: m.riskScore,
          risk_score_band: m.riskScoreBand,
          risk_score_factors: m.riskScoreFactors,
          risk_score_last_computed_at: m.riskScoreLastComputedAt,
          risk_snoozed_until: m.riskSnoozedUntil,
        })),
        next_cursor: page.nextCursor,
        summary: {
          warning: page.summary.warning,
          'at-risk': page.summary.atRisk,
          critical: page.summary.critical,
          f6_active: f6Active,
          active_max: activeMax,
        },
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        tenantId: tenantCtx.slug,
      },
      'admin.renewals.at-risk.list_failed',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
