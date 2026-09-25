/**
 * F7 retention sweep (migration 0310) — daily deletion of closed E-Blasts
 * past their `retention_years`.
 * POST `/api/cron/broadcasts/retention-sweep` (GET = POST for Vercel Cron).
 *
 * Schedule: `50 20 * * *` UTC = 03:50 Asia/Bangkok (vercel.json; native
 * Vercel Cron, UTC-only, invoked with GET). See docs/runbooks/cron-jobs.md
 * § F7 retention-sweep.
 *
 * Per tenant, `sweepExpiredBroadcasts` deletes terminal E-Blasts whose
 * anchor + retention_years has passed and whose Resend audience is no longer
 * live, in batches of 200: read the batch without a lock, delete each row's
 * Resend copy outside any transaction (a row whose copy cannot be deleted is
 * kept), then delete the confirmed rows in one `runInTenant` transaction per
 * batch, opened by the tenant-bound repo's `withTx` (an outer `runInTenant`
 * here would only hold an idle connection around them). Children go by
 * ON DELETE CASCADE; images are stamped for the daily image sweep in the same
 * transaction; one counts-only `broadcast_retention_swept` audit row per
 * tenant per run.
 *
 * NOT gated on `FEATURE_F7_BROADCASTS`: retention is an obligation on data
 * already held, whether or not the tenant still uses the marketing feature.
 * A tenant that switched F7 off still holds rows that must expire.
 *
 * READ_ONLY_MODE: skipped with 200 `{ skipped: true, reason: 'read_only_mode' }`
 * (the `prune-expired-invitations` pattern). Vercel Cron invokes GET, and the
 * proxy's write-freeze stops only POST/PUT/PATCH/DELETE, so without this check
 * an emergency freeze would still delete rows (and Resend copies) nightly. 200,
 * not 503, so the cron does not retry-storm.
 *
 * Failure mode (copied from `sweep-eventcreate-idempotency`): a tenant's
 * failure is logged and reported in `perTenant`, never blocks another tenant,
 * and the response stays 200 — a 500 would hide the tenants that DID succeed.
 * The alert rides `broadcasts_retention_sweep_failed_total{tenant}`. The body
 * carries counts only. The log carries the error CLASS and SQLSTATE only —
 * never the message: a Drizzle `Failed query:` message quotes the statement's
 * parameters, which can include a `related_member_id`.
 *
 * Auth: Bearer `CRON_SECRET` (constant-time `verifyCronBearer`, as the other
 * F7 crons).
 */
import { NextResponse, type NextRequest } from 'next/server';

import { makeSweepExpiredBroadcastsDeps, sweepExpiredBroadcasts } from '@/modules/broadcasts';
import { verifyCronBearer } from '@/lib/cron-auth';
import { pgErrorCode } from '@/lib/db-errors';
import { env } from '@/lib/env';
import { errKind, rootCause } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Each tenant's run is bounded by the use case's own 60 s budget (checked
// between batches), so a handful of tenants fits; the backlog, if any, clears
// over successive daily ticks.
export const maxDuration = 300;

/**
 * Single-tenant deployment today (SweCham). F10 multi-tenant onboarding
 * replaces this with the tenant catalogue — the loop below already iterates.
 */
async function listKnownTenants(): Promise<ReadonlyArray<string>> {
  return [env.tenant.slug];
}

type TenantOutcome =
  | {
      readonly tenantId: string;
      readonly outcome: 'success';
      readonly sweptCount: number;
      readonly imagesMarked: number;
      readonly batches: number;
      readonly budgetExhausted: boolean;
      readonly providerCopyKeptTransient: number;
      readonly providerCopyKeptRefused: number;
      readonly oldestAnchor: Date | null;
      readonly newestAnchor: Date | null;
    }
  | { readonly tenantId: string; readonly outcome: 'error'; readonly sweptCount?: number };

// Vercel-native Cron invokes each scheduled path with a GET; the Bearer-gated
// logic lives in POST. POST is hoisted, so the forward ref is safe.
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  // READ_ONLY_MODE short-circuit — REQUIRED here: GET is not caught by the
  // proxy write-freeze, and this handler DELETEs rows and Resend copies.
  if (env.flags.readOnlyMode) {
    logger.info({}, 'cron.broadcasts.retention_sweep.read_only_mode');
    return NextResponse.json({ skipped: true, reason: 'read_only_mode' }, { status: 200 });
  }

  const startedAt = Date.now();
  const perTenant: TenantOutcome[] = [];

  for (const tenantId of await listKnownTenants()) {
    try {
      const result = await sweepExpiredBroadcasts(
        makeSweepExpiredBroadcastsDeps(tenantId, `cron-retention-sweep-${startedAt}`),
      );
      if (result.ok) {
        broadcastsMetrics.retentionSwept(tenantId, result.value.sweptCount);
        if (result.value.providerCopyKeptTransient > 0) {
          broadcastsMetrics.retentionProviderCopyKept(tenantId, 'transient', result.value.providerCopyKeptTransient);
        }
        if (result.value.providerCopyKeptRefused > 0) {
          broadcastsMetrics.retentionProviderCopyKept(tenantId, 'refused', result.value.providerCopyKeptRefused);
        }
        logger.info(
          { tenantId, ...result.value },
          'cron.broadcasts.retention_sweep.tenant_complete',
        );
        perTenant.push({ tenantId, outcome: 'success', ...result.value });
      } else {
        // The rows that committed before the failure stay deleted — count them.
        broadcastsMetrics.retentionSwept(tenantId, result.error.sweptCount);
        broadcastsMetrics.retentionSweepFailed(tenantId);
        logger.error(
          {
            tenantId,
            sweptCount: result.error.sweptCount,
            err: errKind(rootCause(result.error)),
            code: pgErrorCode(rootCause(result.error)),
            errorId: 'F7.cron.retention_sweep.server_error',
          },
          'cron.broadcasts.retention_sweep.server_error',
        );
        perTenant.push({ tenantId, outcome: 'error', sweptCount: result.error.sweptCount });
      }
    } catch (e) {
      broadcastsMetrics.retentionSweepFailed(tenantId);
      logger.error(
        { tenantId, err: errKind(e), errorId: 'F7.cron.retention_sweep.uncaught' },
        'cron.broadcasts.retention_sweep.uncaught_error',
      );
      perTenant.push({ tenantId, outcome: 'error' });
    }
  }

  logger.info(
    { tenants: perTenant.length, durationMs: Date.now() - startedAt },
    'cron.broadcasts.retention_sweep.tick_complete',
  );
  return NextResponse.json({ ok: true, perTenant }, { status: 200 });
}
