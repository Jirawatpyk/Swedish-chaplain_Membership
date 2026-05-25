/**
 * F9 (T035) — dashboard snapshot refresh COORDINATOR cron.
 * POST `/api/cron/insights/snapshot-refresh-coordinator`.
 *
 * Triggered every ~5 min by cron-job.org (docs/runbooks/cron-jobs.md § F9) to
 * keep `dashboard_metrics_cache` fresh (FR-005; the dashboard reads the cached
 * row). Single-tenant SweCham MVP: refreshes the deployed tenant directly.
 * Multi-tenant SaaS fan-out (iterate the tenant catalogue, prioritise
 * `stale=true` rows, call the per-tenant route) is deferred to F10.
 *
 * Auth: Bearer `CRON_SECRET` (constant-time). Returns 200 `{ skipped }` when
 * `FEATURE_F9_DASHBOARD` is off so cron-job.org never retry-storms dark-launch.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  computeDashboardSnapshot,
  makeComputeDashboardSnapshotDeps,
} from '@/modules/insights';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { insightsMetrics } from '@/lib/metrics';
import { verifyCronBearer } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  if (!env.features.f9Dashboard) {
    return NextResponse.json({ skipped: true, reason: 'feature_disabled' }, { status: 200 });
  }

  const tenant = resolveTenantFromRequest(request);
  const result = await computeDashboardSnapshot(
    tenant,
    makeComputeDashboardSnapshotDeps(tenant.slug),
  );

  const durationMs = Date.now() - startedAt;
  if (!result.ok) {
    insightsMetrics.snapshotRefresh('failed', tenant.slug);
    logger.error(
      { tenantId: tenant.slug, error: result.error, durationMs },
      'cron.insights.snapshot_coordinator.compute_failed',
    );
    return NextResponse.json(
      { refreshed: 0, failed: 1, skipped: 0, durationMs },
      { status: 200 }, // 200 so cron-job.org doesn't retry-storm; failure is logged
    );
  }

  insightsMetrics.snapshotRefreshDurationMs(durationMs);
  insightsMetrics.snapshotRefresh('ok', tenant.slug);
  logger.info(
    { tenantId: tenant.slug, durationMs },
    'cron.insights.snapshot_coordinator.tick_complete',
  );
  return NextResponse.json({ refreshed: 1, failed: 0, skipped: 0, durationMs }, { status: 200 });
}
