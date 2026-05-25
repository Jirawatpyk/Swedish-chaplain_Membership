/**
 * F9 (T035) — per-tenant dashboard snapshot refresh cron.
 * POST `/api/cron/insights/snapshot-refresh/[tenantId]`.
 *
 * Recomputes + upserts one tenant's `dashboard_metrics_cache` row. Idempotent
 * (the snapshot is a derived projection). Invoked by the coordinator's fan-out
 * (F10) or manually for a forced refresh. Tenant scoping is enforced by
 * `computeDashboardSnapshot`'s `runInTenant` (RLS).
 *
 * Auth: Bearer `CRON_SECRET` (constant-time).
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  computeDashboardSnapshot,
  makeComputeDashboardSnapshotDeps,
} from '@/modules/insights';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { insightsMetrics } from '@/lib/metrics';
import { verifyCronBearer } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  const startedAt = Date.now();

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  if (!env.features.f9Dashboard) {
    return NextResponse.json({ skipped: true, reason: 'feature_disabled' }, { status: 200 });
  }

  const { tenantId } = await context.params;
  let tenant;
  try {
    tenant = asTenantContext(tenantId);
  } catch {
    return NextResponse.json({ error: { code: 'invalid_tenant' } }, { status: 400 });
  }

  const result = await computeDashboardSnapshot(
    tenant,
    makeComputeDashboardSnapshotDeps(tenant.slug),
  );
  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    insightsMetrics.snapshotRefresh('failed', tenant.slug);
    logger.error(
      { tenantId: tenant.slug, error: result.error, durationMs },
      'cron.insights.snapshot_refresh.compute_failed',
    );
    return NextResponse.json({ refreshed: false, durationMs }, { status: 200 });
  }

  insightsMetrics.snapshotRefreshDurationMs(durationMs);
  insightsMetrics.snapshotRefresh('ok', tenant.slug);
  logger.info(
    { tenantId: tenant.slug, durationMs },
    'cron.insights.snapshot_refresh.tick_complete',
  );
  return NextResponse.json({ refreshed: true, durationMs }, { status: 200 });
}
