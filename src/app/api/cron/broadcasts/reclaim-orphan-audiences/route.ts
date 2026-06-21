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
 */
import { NextResponse, type NextRequest } from 'next/server';

import {
  reclaimOrphanedAudiences,
  makeReclaimOrphanedAudiencesDeps,
} from '@/modules/broadcasts';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
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
  });

  if (!result.ok) {
    logger.error(
      {
        tenantId: tenant.slug,
        message: result.error.message,
      },
      'cron.broadcasts.reclaim_orphan_audiences.server_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  const { scanned, orphaned, deleted, failed, skippedNonMatching } = result.value;

  logger.info(
    { tenantId: tenant.slug, scanned, orphaned, deleted, failed, skippedNonMatching },
    'cron.broadcasts.reclaim_orphan_audiences.tick_complete',
  );

  return NextResponse.json(
    { scanned, orphaned, deleted, failed, skippedNonMatching },
    { status: 200 },
  );
}
