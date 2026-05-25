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
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();

  // Shared cron-auth gate: Bearer verify + IP rate-limit + probe audit on a
  // rejected 401 (Principle I § 4 — no silent 401s). Matches the F8 coordinators.
  const gate = await gateCronBearerOrRespond(request, {
    route: 'insights:snapshot-refresh-coordinator',
    metricsCounter: () =>
      insightsMetrics.auditEmitFailed('cron_bearer_auth_rejected', env.tenant.slug),
  });
  if (gate) return gate;

  if (!env.features.f9Dashboard) {
    return NextResponse.json({ skipped: true, reason: 'feature_disabled' }, { status: 200 });
  }

  try {
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
  } catch (e) {
    // Defence-in-depth: tenant resolution / deps construction throwing outside
    // the use-case must not surface as a 500 (cron-job.org would retry-storm).
    // Return the same 200 `{ failed: 1 }` shape + meter, so every failure mode
    // has uniform retry semantics + a metric signal (errKind only — no message).
    const durationMs = Date.now() - startedAt;
    insightsMetrics.snapshotRefresh('failed', env.tenant.slug);
    logger.error(
      {
        tenantId: env.tenant.slug,
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
        durationMs,
      },
      'cron.insights.snapshot_coordinator.threw',
    );
    return NextResponse.json({ refreshed: 0, failed: 1, skipped: 0, durationMs }, { status: 200 });
  }
}
