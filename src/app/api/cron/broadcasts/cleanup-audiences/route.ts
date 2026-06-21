/**
 * PR-2 Task 4 — cleanup-audiences cron
 * POST `/api/cron/broadcasts/cleanup-audiences` (defect #5).
 *
 * Triggered every 15 min by cron-job.org (per docs/runbooks/cron-jobs.md).
 * For each terminal broadcast (sent / cancelled / failed_to_dispatch /
 * rejected / partial_delivery_accepted) whose Resend audience has NOT yet
 * been deleted (`audience_deleted_at IS NULL`, `updated_at` older than the
 * grace window), calls `broadcastsGateway.deleteAudience` and stamps
 * `audience_deleted_at` in a tenant-scoped tx.
 *
 * Without this sweep, Resend audiences accumulate indefinitely, wasting
 * sub-processor storage and obscuring the active-audience count in the
 * Resend dashboard (and eventually hitting per-account plan limits).
 *
 * Auth: Bearer token via `CRON_SECRET` (shared with F4 / F5 / F7 dispatch
 * / F7 reconcile-stuck-sending / F7 prune-expired-drafts).
 *
 * Kill-switch: `FEATURE_F7_BROADCASTS=false` → 200 + { skipped: true }
 * so cron-job.org does NOT retry-storm a dark-launch period.
 *
 * Mirrors the reconcile-stuck-sending cron in auth + kill-switch + shape.
 * Single-tenant SweCham MVP — runs against the deployed tenant slug.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  cleanupOrphanedAudiences,
  makeCleanupOrphanedAudiencesDeps,
} from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

/**
 * Grace window: 1 hour. Prevents racing with Resend's own post-send
 * processing on very recently terminal broadcasts (e.g. a just-cancelled
 * broadcast whose Resend audience the webhook handler may still be
 * writing delivery events to).
 */
const GRACE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Per-tick candidate limit: 50 rows per tenant (matches reconcile-stuck-
 * sending's `MAX_PER_TICK`). The use-case parallelises deletes in chunks of
 * 5 via `Promise.allSettled`, so 50 rows × ceil(50/5) chunks stays well
 * within the function timeout even when some deletes hit the Resend 5xx
 * retry path. At steady-state SweCham scale this is above the expected
 * queue depth; the next 15-min tick picks up any remainder.
 */
const LIMIT = 50;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

  if (!env.features.f7Broadcasts) {
    logger.info(
      { tenantId: tenant.slug },
      'cron.broadcasts.cleanup_audiences.feature_disabled',
    );
    return NextResponse.json(
      { skipped: true, reason: 'feature_disabled' },
      { status: 200 },
    );
  }

  const deps = makeCleanupOrphanedAudiencesDeps(tenant.slug);

  const result = await cleanupOrphanedAudiences(deps, {
    graceMs: GRACE_MS,
    limit: LIMIT,
  });

  if (!result.ok) {
    logger.error(
      {
        tenantId: tenant.slug,
        message: result.error.message,
      },
      'cron.broadcasts.cleanup_audiences.server_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  const { processed, deleted, failed } = result.value;

  logger.info(
    { tenantId: tenant.slug, processed, deleted, failed },
    'cron.broadcasts.cleanup_audiences.tick_complete',
  );

  return NextResponse.json({ processed, deleted, failed }, { status: 200 });
}
