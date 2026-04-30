/**
 * T125a — GET `/api/admin/broadcasts/sla-stats`.
 *
 * FR-013 N2 remediation. Aggregates time-to-decision (submitted_at →
 * approved_at/rejected_at) over rolling 30 days. Surfaces banner
 * severity per spec § 2.7 thresholds.
 *
 * Authz: admin OR manager (read-only access on this surface).
 *
 * Tenant scoping: query runs inside `runInTenant` so RLS filters to
 * caller's tenant.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import {
  errorResponse,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const TARGET_SLA_HOURS = 48;

type BannerSeverity = 'green' | 'amber' | 'red';

function computeSeverity(
  median: number | null,
  p95: number | null,
): BannerSeverity {
  if (median === null || p95 === null) return 'green';
  if (p95 > 48) return 'red';
  if (median > 24 || p95 > 40) return 'amber';
  return 'green';
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);

  try {
    const rows = (await runInTenant(tenantCtx, async (tx) => {
      return await tx.execute(sql`
        SELECT
          COUNT(*)::int AS decision_count,
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (
              COALESCE(approved_at, rejected_at) - submitted_at
            )) / 3600.0
          ) AS median_hours,
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (
              COALESCE(approved_at, rejected_at) - submitted_at
            )) / 3600.0
          ) AS p95_hours
        FROM broadcasts
        WHERE tenant_id = ${tenantCtx.slug}
          AND submitted_at >= NOW() - INTERVAL '30 days'
          AND status IN ('approved', 'rejected', 'sending', 'sent')
      `);
    })) as unknown as Array<{
      decision_count: number;
      median_hours: string | number | null;
      p95_hours: string | number | null;
    }>;

    const row = rows[0];
    const decisionCount = row?.decision_count ?? 0;
    const median =
      row?.median_hours === null || row?.median_hours === undefined
        ? null
        : Number(row.median_hours);
    const p95 =
      row?.p95_hours === null || row?.p95_hours === undefined
        ? null
        : Number(row.p95_hours);
    const bannerSeverity = computeSeverity(median, p95);

    return NextResponse.json(
      {
        targetSlaHours: TARGET_SLA_HOURS,
        rollingWindow: '30d' as const,
        medianTimeToDecisionHours: median,
        p95TimeToDecisionHours: p95,
        decisionCount,
        bannerSeverity,
        computedAt: new Date().toISOString(),
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
      },
      'admin.broadcasts.sla_stats.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
