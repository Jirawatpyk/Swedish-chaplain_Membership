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
  AUDIENCE_CLEANUP_GRACE_MS,
  cleanupOrphanedAudiences,
  makeCleanupOrphanedAudiencesDeps,
} from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
import { cronReadOnlyGuard } from '@/lib/cron-read-only-guard';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

/**
 * Grace window: 1 hour. Prevents racing with Resend's own post-send
 * processing on very recently terminal broadcasts (e.g. a just-cancelled
 * broadcast whose Resend audience the webhook handler may still be
 * writing delivery events to).
 */
const GRACE_MS = AUDIENCE_CLEANUP_GRACE_MS; // 1 hour — the use case's constant (spec 140 s2c review round 1)

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
// Spec 140 s2c — `CLEANUP_MAX_DURATION_MS` (300 s). The orphan drain starts no
// chunk after `ORPHAN_DRAIN_STOP_MS` (240 s), so its last chunk's two bounded
// Resend calls finish inside it (pinned by cleanup-orphaned-audiences-drain.test.ts).
export const maxDuration = 300;

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // #408 — READ_ONLY_MODE: Vercel Cron calls with GET, which the proxy
  // write-freeze does not cover, so the route skips by itself.
  const frozen = cronReadOnlyGuard('/api/cron/broadcasts/cleanup-audiences');
  if (frozen) return frozen;

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
        // The error CLASS (the use case answers `errKind`), never a driver message.
        err: result.error.errClass,
        // Review round 1 (code-review #4) — the orphan drain still ran.
        orphans: result.error.orphans,
      },
      'cron.broadcasts.cleanup_audiences.server_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  // Spec 140 s2c — `orphans` is the orphan drain's counts (no ids).
  const { processed, deleted, failed, orphans } = result.value;

  logger.info(
    { tenantId: tenant.slug, processed, deleted, failed, orphans },
    'cron.broadcasts.cleanup_audiences.tick_complete',
  );

  return NextResponse.json({ processed, deleted, failed, orphans }, { status: 200 });
}
