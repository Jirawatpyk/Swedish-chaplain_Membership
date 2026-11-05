/**
 * PR-2 Task 4 — reclaim-orphan-audiences cron
 * POST `/api/cron/broadcasts/reclaim-orphan-audiences`.
 *
 * Triggered daily by cron-job.org (per docs/runbooks/cron-jobs.md).
 * Safety-net that reclaims orphaned Resend audiences — audiences that exist
 * at Resend but have no matching local broadcast row. These arise when a
 * broadcast row is hard-deleted (GDPR erasure, manual purge) after a Resend
 * audience was already created during dispatch, or when dispatch crashed
 * mid-flight after `gateway.createAudience` but before
 * `broadcastsRepo.attachAudienceId`.
 *
 * Complements `cleanup-audiences` (which handles the case where the broadcast
 * row EXISTS and is terminal). Run both crons for full audience hygiene:
 *   - cleanup-audiences  → row exists, terminal → delete audience + stamp row
 *   - reclaim-orphan-audiences → row is GONE → delete dangling Resend audience
 *
 * Lists all audiences from Resend, filters by naming convention
 * `broadcast-{tenantSlug}-{uuid}`, applies a 24h grace window, cross-checks
 * broadcast IDs against the DB, and deletes audiences with no DB row.
 * No DB write on success — there is no row to stamp (that is the whole point).
 *
 * Auth: Bearer token via `CRON_SECRET` (shared with F4 / F5 / F7 other crons).
 *
 * Kill-switch: `FEATURE_F7_BROADCASTS=false` → 200 + { skipped: true }
 * so cron-job.org does NOT retry-storm a dark-launch period.
 *
 * Mirrors `cleanup-audiences/route.ts` structurally.
 *
 * Spec 140 slice 3 (DT5): a function budget of `maxDuration` = 300 s, and one
 * deadline inside it (start + maxDuration − `RECLAIM_DEADLINE_MARGIN_MS`) that
 * covers the Resend listing and the delete chunks. A run cut by it answers 200
 * with `truncated` / `deferredDeletes`. Nothing resumes: the next daily run
 * lists again from page one, and the deferred orphans are found and deleted
 * then. The deadline is the route's own; no request field can move it.
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  reclaimOrphanedAudiences,
  makeReclaimOrphanedAudiencesDeps,
  RECLAIM_DEADLINE_MARGIN_MS,
} from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
import { cronReadOnlyGuard } from '@/lib/cron-read-only-guard';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

/**
 * Grace window: 24 hours. Audiences whose `createdAt` is within the last 24h
 * are skipped — they may belong to an in-flight dispatch that hasn't committed
 * its broadcast row yet. A longer window than cleanup-audiences (1h) is
 * appropriate here because this cron is the safety-net for truly orphaned
 * audiences (missing DB row) — false-positive deletes of a fresh-dispatch
 * audience would disrupt active sends.
 */
const GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Per-tick candidate limit: 200 (after name-matching + grace filtering, before
 * the DB existence check). Higher than cleanup-audiences (50) because reclaim
 * runs daily, not every 15 min — a longer dwell time means a larger potential
 * backlog to drain per tick.
 */
const LIMIT = 200;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Spec 140 slice 3 (DT5) — the run's budget; the use case's deadline sits
// RECLAIM_DEADLINE_MARGIN_MS inside it.
export const maxDuration = 300;

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // #408 — READ_ONLY_MODE: Vercel Cron calls with GET, which the proxy
  // write-freeze does not cover, so the route skips by itself.
  const frozen = cronReadOnlyGuard('/api/cron/broadcasts/reclaim-orphan-audiences');
  if (frozen) return frozen;

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

  if (!env.features.f7Broadcasts) {
    logger.info(
      { tenantId: tenant.slug },
      'cron.broadcasts.reclaim_orphan_audiences.feature_disabled',
    );
    return NextResponse.json(
      { skipped: true, reason: 'feature_disabled' },
      { status: 200 },
    );
  }

  const deps = makeReclaimOrphanedAudiencesDeps(tenant.slug);

  const result = await reclaimOrphanedAudiences(deps, {
    graceMs: GRACE_MS,
    limit: LIMIT,
    deadlineAt: new Date(startedAt + maxDuration * 1000 - RECLAIM_DEADLINE_MARGIN_MS),
  });

  if (!result.ok) {
    logger.error(
      {
        tenantId: tenant.slug,
        errMessage: result.error.message,
      },
      'cron.broadcasts.reclaim_orphan_audiences.server_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  const {
    scanned,
    orphaned,
    deleted,
    failed,
    skippedLastAudience,
    skippedNonMatching,
    truncated,
    deferredDeletes,
  } = result.value;

  logger.info(
    {
      tenantId: tenant.slug,
      scanned,
      orphaned,
      deleted,
      failed,
      skippedLastAudience,
      skippedNonMatching,
      truncated,
      deferredDeletes,
      durationMs: Date.now() - startedAt,
    },
    'cron.broadcasts.reclaim_orphan_audiences.tick_complete',
  );

  return NextResponse.json(
    { scanned, orphaned, deleted, failed, skippedLastAudience, skippedNonMatching, truncated, deferredDeletes },
    { status: 200 },
  );
}
