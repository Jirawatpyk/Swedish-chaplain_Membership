/**
 * F9 (T072) — async export-job worker cron.
 * POST `/api/cron/insights/process-export-jobs`.
 *
 * Triggered every ~5 min by cron-job.org (docs/runbooks/cron-jobs.md § F9):
 *   1. claims + processes `requested` jobs (E-Book / JSON; GDPR in US6),
 *   2. reclaims stuck `processing` jobs (crashed worker, critique E2),
 *   3. TTL-sweeps `ready|delivered` jobs past `expires_at` (deletes the private
 *      Blob object + transitions to `expired`).
 *
 * Auth: Bearer `CRON_SECRET` (constant-time). 200 `{ skipped }` when
 * `FEATURE_F9_DASHBOARD` is off (no dark-launch retry-storm); 200 on failure
 * (cron-job.org retry-OFF; failures are logged + metered). Node runtime.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { processExportJob, STUCK_PROCESSING_TIMEOUT_MS } from '@/modules/insights';
import { makeProcessExportJobDeps } from '@/modules/insights/infrastructure/process-export-job-deps';
import { makeDrizzleExportJobRepo } from '@/modules/insights/infrastructure/repos/drizzle-export-job-repo';
import { env } from '@/lib/env';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { insightsMetrics } from '@/lib/metrics';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAIM_BATCH = 25;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = await gateCronBearerOrRespond(request, {
    route: 'insights:process-export-jobs',
    metricsCounter: () =>
      insightsMetrics.auditEmitFailed('cron_auth_audit_emit_failed', env.tenant.slug),
  });
  if (gate) return gate;

  if (!env.features.f9Dashboard) {
    return NextResponse.json({ skipped: true, reason: 'feature_disabled' }, { status: 200 });
  }

  const startedAt = Date.now();
  try {
    const tenant = resolveTenantFromRequest(request);
    const repo = makeDrizzleExportJobRepo(tenant.slug);
    const deps = makeProcessExportJobDeps(tenant.slug);
    let processed = 0;
    let failed = 0;
    let reclaimed = 0;
    let expired = 0;

    // 1) Claim + build requested jobs.
    const requested = await repo.listRequestedIds(tenant, CLAIM_BATCH);
    for (const jobId of requested) {
      const r = await processExportJob(jobId, tenant, deps);
      if (r.ok) processed += 1;
      else failed += 1;
    }

    // 2) Reclaim stuck `processing` jobs (crashed worker).
    const stuck = await repo.listStuckProcessing(tenant, STUCK_PROCESSING_TIMEOUT_MS);
    for (const jobId of stuck) {
      const did = await runInTenant(tenant, (tx) =>
        repo.reclaimStuckInTx(tx, jobId, 'worker_timeout'),
      );
      if (did) {
        reclaimed += 1;
        insightsMetrics.exportJobReclaimed(tenant.slug);
      }
    }

    // 3) TTL sweep — delete the private artefact + mark expired.
    const sweepable = await repo.listSweepable(tenant);
    for (const { jobId, blobKey } of sweepable) {
      if (blobKey !== null) {
        // A delete failure here orphans a private-Blob artefact (member PII for
        // GDPR archives) — never reaped again (sweep only lists ready|delivered).
        // Don't fail the tick, but it MUST be observable, not silently swallowed.
        await deps.blob.delete(blobKey).catch((delErr) => {
          logger.warn(
            { tenantId: tenant.slug, jobId, errKind: errKind(delErr) },
            'cron.insights.export_job.sweep_blob_delete_failed',
          );
        });
      }
      const did = await runInTenant(tenant, (tx) => repo.markExpiredInTx(tx, jobId));
      if (did) expired += 1;
    }

    const durationMs = Date.now() - startedAt;
    logger.info(
      { tenantId: tenant.slug, processed, failed, reclaimed, expired, durationMs },
      'cron.insights.process_export_jobs.tick_complete',
    );
    return NextResponse.json(
      { processed, failed, reclaimed, expired, durationMs },
      { status: 200 },
    );
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    // Meter the tick-level failure (parity with the snapshot crons) so a metric-
    // based alert fires — a log line alone won't trip OTel alert rules.
    insightsMetrics.exportJobProcessed('tick', 'failed', env.tenant.slug);
    logger.error(
      { tenantId: env.tenant.slug, errKind: errKind(e), durationMs },
      'cron.insights.process_export_jobs.threw',
    );
    return NextResponse.json({ processed: 0, failed: 1, durationMs }, { status: 200 });
  }
}
