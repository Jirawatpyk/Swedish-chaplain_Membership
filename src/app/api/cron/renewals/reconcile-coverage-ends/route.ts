/**
 * 0306 — Hourly reconcile-coverage-ends cron.
 *
 * Converges "end membership coverage" requests (`renewal_cycles.end_coverage_*`)
 * and runs the durable backstop — see `reconcileMembershipCoverageEnds`:
 *   - a refund-backed request ends the member's coverage once its F5 refund
 *     settles `succeeded`; a `failed` settle keeps the membership;
 *   - a plain request (an inline end that failed) is retried;
 *   - staff "End membership" decisions whose route call was lost are
 *     recovered from their refund / credit-note rows.
 *
 * HOURLY on purpose: most refunds settle within minutes, and every hour a
 * refunded member keeps access is benefit given without payment. Its own
 * route (not folded into the daily reactivation pass) so a failure there can
 * never skip this one.
 *
 * Single-route housekeeping shape (mirrors `reconcile-issued-orphans`): no
 * `[tenantId]` segment — MVP single tenant (`env.tenant.slug`).
 * Auth: Bearer via `CRON_SECRET` (`gateCronBearerOrRespond`). Env gate:
 * `FEATURE_F8_RENEWALS`. READ_ONLY_MODE → 200 skipped.
 *
 * Concurrency: every cycle write takes the per-cycle advisory lock
 * (`renewals:{tenant}:{cycle}`) + a status CAS, so an overlapping run is a
 * safe no-op.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import { reconcileMembershipCoverageEnds, makeRenewalsDeps } from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vercel-native Cron invokes with GET; the Bearer-gated logic lives in POST.
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gateResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/reconcile-coverage-ends',
    metricsCounter: () => renewalsMetrics.coordinatorAuditEmitFailed('reconcile_coverage_ends'),
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (gateResponse) return gateResponse;

  if (!env.features.f8Renewals) {
    renewalsMetrics.coverageEndReconcileRunCompleted(env.tenant.slug, 'skipped_flag_disabled');
    return NextResponse.json({ skipped: true, reason: 'feature_flag_disabled' }, { status: 200 });
  }
  if (env.flags.readOnlyMode) {
    renewalsMetrics.coordinatorSkippedReadOnly('reconcile_coverage_ends');
    renewalsMetrics.coverageEndReconcileRunCompleted(env.tenant.slug, 'skipped_read_only');
    return NextResponse.json({ skipped: true, reason: 'read_only_mode' }, { status: 200 });
  }

  const correlationId = uuidv7();
  const tenantId = env.tenant.slug;
  const startedAt = Date.now();

  try {
    const result = await reconcileMembershipCoverageEnds(makeRenewalsDeps(tenantId), {
      tenant: asTenantContext(tenantId),
    });
    if (!result.ok) {
      logger.error(
        { tenantId, correlationId, errName: result.error.errName },
        'cron.renewals.reconcile_coverage_ends.failed',
      );
      renewalsMetrics.coverageEndReconciled(tenantId, 'errored', 1);
      renewalsMetrics.coverageEndReconcileRunCompleted(tenantId, 'failure');
      return NextResponse.json({ error: { code: 'server_error' }, tenant_id: tenantId }, { status: 500 });
    }
    const v = result.value;
    renewalsMetrics.coverageEndReconciled(tenantId, 'ended', v.ended);
    renewalsMetrics.coverageEndReconciled(tenantId, 'refund_failed_kept', v.abandonedRefundFailed);
    renewalsMetrics.coverageEndReconciled(tenantId, 'expired', v.expired);
    renewalsMetrics.coverageEndReconciled(tenantId, 'stranded_cleared', v.strandedCleared);
    renewalsMetrics.coverageEndReconciled(tenantId, 'backstop_applied', v.backstopApplied);
    renewalsMetrics.coverageEndReconciled(tenantId, 'lookup_unresolved', v.lookupUnresolved);
    renewalsMetrics.coverageEndReconciled(tenantId, 'errored', v.errored);
    renewalsMetrics.coverageEndOldestWaitingHours(tenantId, v.oldestWaitingHours);
    renewalsMetrics.coverageEndReconcileRunCompleted(tenantId, 'success');
    const body = {
      skipped: false as const,
      tenant_id: tenantId,
      ended: v.ended,
      refund_failed_kept: v.abandonedRefundFailed,
      waiting: v.waiting,
      lookup_unresolved: v.lookupUnresolved,
      expired: v.expired,
      stranded_cleared: v.strandedCleared,
      backstop_applied: v.backstopApplied,
      oldest_waiting_hours: v.oldestWaitingHours,
      errored: v.errored,
      duration_ms: Date.now() - startedAt,
    };
    logger.info({ correlationId, ...body }, 'cron.renewals.reconcile_coverage_ends.complete');
    return NextResponse.json(body);
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e : new Error(String(e)), tenantId, correlationId },
      'cron.renewals.reconcile_coverage_ends.unexpected_error',
    );
    renewalsMetrics.coverageEndReconciled(tenantId, 'errored', 1);
    renewalsMetrics.coverageEndReconcileRunCompleted(tenantId, 'failure');
    return NextResponse.json({ error: { code: 'server_error' }, tenant_id: tenantId }, { status: 500 });
  }
}
