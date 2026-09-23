/**
 * F7 US6 / Phase 8 — T171a daily draft-expiry cleanup cron.
 * POST `/api/cron/broadcasts/prune-expired-drafts`.
 *
 * Triggered DAILY by native Vercel Cron (`vercel.json`, UTC-only, invoked
 * with GET — `export const GET = POST` below; cron-job.org is a paused
 * standby). See docs/runbooks/cron-jobs.md § F7 prune-expired-drafts —
 * separate cadence from the 5-min dispatch-scheduled cron because pruning
 * is a low-frequency housekeeping task with no time-sensitive business
 * impact.
 *
 * FR-001a: deletes broadcasts with `status='draft' AND updated_at <
 * now() - interval '30 days'`. No LIFECYCLE audit event (drafts are user-
 * controlled scratch space — preserves the FR-001 "drafts do NOT
 * consume or reserve quota" invariant). Members are not notified of
 * impending draft expiry in MVP.
 *
 * ROUND-3 #9 — it is NOT audit-silent, though, and this header used to say
 * "NO audit event". F119 F2-1 made the prune stamp `deleted_at` on every
 * image of every pruned draft, and each stamp emits `broadcast_image_removed
 * { reason: 'draft_pruned', actor_role: 'system' }` in the same transaction
 * as the DELETE. That is deliberate: the bytes are a member's personal data
 * and their removal is the reachable record of it.
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
  makeReclaimOrphanedImagesDeps,
  pruneExpiredDrafts,
  reclaimOrphanedImages,
} from '@/modules/broadcasts';
import { errKind } from '@/lib/log-id';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Reliability review (2026-09-22) — match the sibling cron
// (`dispatch-scheduled`). This job sweeps every tenant's expired drafts AND
// the orphaned image blobs, so it is not bounded by the default function
// timeout; without this it could be killed mid-sweep and leave the blob store
// and `broadcast_images` disagreeing until the next run.
export const maxDuration = 300;

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

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

  // --- Block 1: the F7 draft prune (unchanged) ------------------------------
  // F119 T035 — each block owns its try/catch and its OK flag; a fault in
  // one never drops the other, and the 500 is decided only at the end.
  let pruneOk = false;
  let prunedCount: number | null = null;
  let cutoff: string | null = null;
  try {
    const deps = makePruneExpiredDraftsDeps(tenantCtx.slug, `cron-prune-drafts-${startedAt}`);
    const result = await pruneExpiredDrafts(deps);
    if (result.ok) {
      pruneOk = true;
      prunedCount = result.value.prunedCount;
      cutoff = result.value.cutoff;
    } else {
      logger.error(
        { tenantId: tenantCtx.slug, message: result.error.message },
        'cron.broadcasts.prune_drafts.server_error',
      );
    }
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        tenantId: tenantCtx.slug,
      },
      'cron.broadcasts.prune_drafts.uncaught_error',
    );
  }

  // --- Block 2: the F119 image-blob sweep (T035) ----------------------------
  // Independently transacted (one tx per row inside the use case), its own
  // flag in the body. T130 (PR-2) adds the reminder / expiry steps here.
  // ROUND-2 S-3 — `retained` is the fourth count: rows the sweep KEPT (and put
  // back in the live set) because live content still embeds their blob URL.
  // F7-1 — `rowsFailed` is the fifth: rows whose per-row tx threw and were
  // left for the next tick. A non-zero count is logged at `error` but the tick
  // stays 200 — a daily-cron 500 would hide the rows that DID succeed, and the
  // alert rides `broadcasts_image_sweep_row_failed_total` instead.
  let imageSweep: {
    ok: boolean;
    scanned?: number;
    blobsDeleted?: number;
    rowsRemoved?: number;
    retained?: number;
    rowsFailed?: number;
  } = { ok: false };
  try {
    const result = await reclaimOrphanedImages(makeReclaimOrphanedImagesDeps(tenantCtx.slug), {
      tenantId: tenantCtx.slug as never,
      now: new Date(),
      requestId: `cron-image-sweep-${startedAt}`,
    });
    if (result.ok) {
      imageSweep = { ok: true, ...result.value };
      if (result.value.rowsFailed > 0) {
        logger.error(
          {
            tenantId: tenantCtx.slug,
            rowsFailed: result.value.rowsFailed,
            scanned: result.value.scanned,
            errorId: 'M119.cron.image_sweep.rows_failed',
          },
          'cron.broadcasts.image_sweep.rows_failed',
        );
      }
    } else {
      logger.error(
        { tenantId: tenantCtx.slug, message: result.error.message, errorId: 'M119.cron.image_sweep' },
        'cron.broadcasts.image_sweep.server_error',
      );
    }
  } catch (e) {
    logger.error(
      { err: errKind(e), tenantId: tenantCtx.slug, errorId: 'M119.cron.image_sweep.uncaught' },
      'cron.broadcasts.image_sweep.uncaught_error',
    );
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    tenantId: tenantCtx.slug,
    pruneOk,
    prunedCount,
    cutoff,
    imageSweep,
    durationMs,
  };

  if (!pruneOk || !imageSweep.ok) {
    logger.error(summary, 'cron.broadcasts.prune_drafts.tick_partial_failure');
    return NextResponse.json({ ...summary, error: { code: 'internal_error' } }, { status: 500 });
  }
  logger.info(summary, 'cron.broadcasts.prune_drafts.tick_complete');
  return NextResponse.json(summary, { status: 200 });
}
