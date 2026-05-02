/**
 * F7 US6 / Phase 8 — T171a daily draft-expiry cleanup cron.
 * POST `/api/cron/broadcasts/prune-expired-drafts`.
 *
 * Triggered DAILY by cron-job.org (per docs/runbooks/cron-jobs.md
 * § F7 prune-expired-drafts) — separate cadence from the 5-min
 * dispatch-scheduled cron because pruning is a low-frequency
 * housekeeping task with no time-sensitive business impact.
 *
 * FR-001a: deletes broadcasts with `status='draft' AND updated_at <
 * now() - interval '30 days'`. NO audit event (drafts are user-
 * controlled scratch space — preserves the FR-001 "drafts do NOT
 * consume or reserve quota" invariant). Members are not notified of
 * impending draft expiry in MVP.
 *
 * Auth: Bearer token via `CRON_SECRET` (shared with F4 outbox-dispatch
 * + F5 stale-pending-count + F7 dispatch-scheduled + F7
 * reconcile-stuck-sending).
 *
 * Single-tenant SweCham MVP — runs against the deployed tenant slug.
 * Future SaaS multi-tenant: iterate tenant catalogue (deferred to F10).
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  makePruneExpiredDraftsDeps,
  pruneExpiredDrafts,
} from '@/modules/broadcasts';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();

  // Verify-fix R3 (Code-M2, 2026-05-02): constant-time Bearer check
  // via shared `verifyCronBearer` helper (matches F4 outbox + F5
  // sweep-stale-pending-refunds). Avoids timing side-channel on
  // CRON_SECRET enumeration.
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);

  // Verify-fix R3 (Errors-H1, 2026-05-02): return 200 + skipped
  // (was 503) so cron-job.org does NOT retry-storm during dark-launch.
  // Operators distinguish "kill-switch off" from "real DB outage" via
  // the explicit `skipped: true, reason` envelope vs the 500 error path.
  if (!env.features.f7Broadcasts) {
    logger.info(
      { tenantId: tenantCtx.slug },
      'cron.broadcasts.prune_drafts.feature_disabled',
    );
    return NextResponse.json(
      { skipped: true, reason: 'feature_disabled' },
      { status: 200 },
    );
  }

  let result;
  try {
    const deps = makePruneExpiredDraftsDeps(tenantCtx.slug);
    result = await pruneExpiredDrafts(deps);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        tenantId: tenantCtx.slug,
      },
      'cron.broadcasts.prune_drafts.uncaught_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  if (!result.ok) {
    logger.error(
      {
        tenantId: tenantCtx.slug,
        message: result.error.message,
      },
      'cron.broadcasts.prune_drafts.server_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error', message: result.error.message } },
      { status: 500 },
    );
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    tenantId: tenantCtx.slug,
    prunedCount: result.value.prunedCount,
    cutoff: result.value.cutoff,
    durationMs,
  };

  logger.info(summary, 'cron.broadcasts.prune_drafts.tick_complete');
  return NextResponse.json(summary, { status: 200 });
}
