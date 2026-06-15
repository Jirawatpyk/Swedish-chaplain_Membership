/**
 * F7 US5 reconciliation cron — POST `/api/cron/broadcasts/reconcile-stuck-sending`.
 *
 * Triggered every 15 min by cron-job.org (per docs/runbooks/cron-jobs.md +
 * perf.md CHK033). For broadcasts stuck in `sending` longer than 24h
 * we reconcile against Resend (FR-028 + R2-NEW-3): if the resource
 * exists we transition to `sent` (webhook events were dropped); if it
 * is missing we mark `failed_to_dispatch` + alert.
 *
 * Auth: Bearer token via `CRON_SECRET` (shared with F4 outbox-dispatch
 * + F5 stale-pending-count + F7 dispatch-scheduled).
 *
 * Concurrency: per-row work is wrapped in
 * `pg_advisory_xact_lock('broadcasts:'+tenant+':'+id)` via
 * `BroadcastsRepo.lockForUpdate` — closes the TOCTOU window between
 * concurrent reconciliation ticks AND the late-arriving Resend
 * webhook from the same broadcast.
 *
 * Single-tenant SweCham MVP — runs against the deployed tenant slug.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';

import {
  asBroadcastId,
  makeReconcileStuckSendingDeps,
  reconcileStuckSending,
  // F7.1a Phase 3 T056 — per-batch auto-retry sweep (FR-005 / 5-attempt budget)
  makeAutoRetryFailedBatchesDeps,
  sweepAutoRetryFailedBatches,
  // Ship-blocker A — batch-completion roll-up sweep
  makeRollUpBatchBroadcastDeps,
  sweepBatchCompletion,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

const MAX_PER_TICK = 50;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Verify-fix R6 (parity with dispatch + prune routes, 2026-05-02):
  // constant-time Bearer check via shared `verifyCronBearer` helper —
  // closes timing side-channel on `CRON_SECRET` brute-force.
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

  // Verify-fix R6 (parity with dispatch + prune routes, 2026-05-02):
  // kill-switch returns 200 + {skipped:true} so cron-job.org does NOT
  // retry-storm a dark-launch period (was 503 → harness retried every
  // 15 min and emitted noise log + duplicate audit fan-out).
  if (!env.features.f7Broadcasts) {
    logger.info(
      { tenantId: tenant.slug },
      'cron.broadcasts.reconcile.feature_disabled',
    );
    return NextResponse.json(
      { skipped: true, reason: 'feature_disabled' },
      { status: 200 },
    );
  }

  // Pick eligible rows. The 24h threshold is also enforced inside the
  // use-case (defence in depth — protects against clock skew between
  // the cron host + DB; the use-case re-checks before mutating).
  let eligible: ReadonlyArray<{ broadcast_id: string }>;
  try {
    eligible = await runInTenant(tenant, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT broadcast_id::text AS broadcast_id
        FROM broadcasts
        WHERE tenant_id = ${tenant.slug}
          AND status = 'sending'
          AND sending_started_at IS NOT NULL
          AND sending_started_at < now() - interval '24 hours'
          -- H-1 review — batched broadcasts carry NULL resend_broadcast_id
          -- on the parent row (each batch holds its own provider id), so the
          -- single-audience reconcile would wrongly mark a fully-dispatched
          -- batched broadcast failed_to_dispatch (+ lose quota). Exclude
          -- them; their completion is the batch-completion roll-up below.
          AND NOT EXISTS (
            SELECT 1 FROM broadcast_batch_manifests bm
            WHERE bm.tenant_id = broadcasts.tenant_id
              AND bm.broadcast_id = broadcasts.broadcast_id
          )
        ORDER BY sending_started_at ASC
        LIMIT ${MAX_PER_TICK}
        FOR UPDATE SKIP LOCKED
      `)) as unknown as Array<{ broadcast_id: string }>;
      return rows;
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenant.slug,
      },
      'cron.broadcasts.reconcile.eligible_query_failed',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  const summary = {
    processed: 0,
    reconciled_sent: 0,
    reconciled_failed_resource_missing: 0,
    not_stuck_yet: 0,
    not_found: 0,
    gateway_error: 0,
    server_error: 0,
    uncaught_error: 0,
  };

  const deps = makeReconcileStuckSendingDeps(tenant.slug);

  // R6 staff-review W-P4 fix — parallelise reconciliation across
  // chunks to avoid approaching the Vercel function timeout. Each row
  // issues `findById` + `broadcastsGateway.retrieveBroadcast` (~200ms
  // Resend RTT) + `withTx` (write). Sequential: 50 rows × 225ms ≈
  // 11.25s, dangerously close to the 10s default. Parallel chunks of
  // 5 (semaphore-equivalent): ~50/5 × 225ms ≈ 2.25s. Each row owns a
  // distinct `(tenant, broadcast_id)` advisory-lock namespace inside
  // the use-case so concurrent invocations don't contend, and
  // `Promise.allSettled` ensures one row's throw doesn't short-circuit
  // the others (mirrors the pre-fix per-row try/catch isolation).
  const RECONCILE_CONCURRENCY = 5;
  const handleOne = async (row: { broadcast_id: string }): Promise<void> => {
    summary.processed++;
    try {
      const result = await reconcileStuckSending(deps, {
        broadcastId: asBroadcastId(row.broadcast_id),
        requestId: null,
      });
      if (!result.ok) {
        if (result.error.kind === 'reconcile.gateway_error') {
          summary.gateway_error++;
          logger.warn(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              cause: result.error.cause,
            },
            'cron.broadcasts.reconcile.gateway_error',
          );
        } else {
          summary.server_error++;
          logger.error(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              message: result.error.message,
            },
            'cron.broadcasts.reconcile.server_error',
          );
        }
        return;
      }
      switch (result.value.kind) {
        case 'reconciled_sent':
          summary.reconciled_sent++;
          break;
        case 'reconciled_failed_resource_missing':
          summary.reconciled_failed_resource_missing++;
          logger.error(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
            },
            'cron.broadcasts.reconcile.resend_resource_missing',
          );
          break;
        case 'not_stuck_yet':
          summary.not_stuck_yet++;
          break;
        case 'broadcast_not_found':
          summary.not_found++;
          break;
      }
    } catch (e) {
      summary.uncaught_error++;
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
          tenantId: tenant.slug,
          broadcastId: row.broadcast_id,
        },
        'cron.broadcasts.reconcile.uncaught_error',
      );
    }
  };

  for (let i = 0; i < eligible.length; i += RECONCILE_CONCURRENCY) {
    const chunk = eligible.slice(i, i + RECONCILE_CONCURRENCY);
    await Promise.allSettled(chunk.map(handleOne));
  }

  // F7.1a Phase 3 T056 — per-batch auto-retry sweep (FR-005). After
  // the broadcast-level reconciliation completes, sweep failed
  // batch_manifests with retry_count < 5 + cool-off elapsed and
  // re-queue them. The dispatch-batches cron (T055) picks them up
  // on the next 5-min tick.
  //
  // Run AFTER the broadcast loop so that any broadcast just
  // reconciled `sending → sent` doesn't have its individual batches
  // unnecessarily retried. The batch-level sweep is idempotent
  // regardless — the use case checks `status='failed' AND retry_count
  // < 5` at the moment of mutation; a flipped-since-scan row just
  // surfaces as a no-op.
  let batchSweep: Awaited<ReturnType<typeof sweepAutoRetryFailedBatches>> = {
    eligibleCount: 0,
    retriedCount: 0,
    errorCount: 0,
    outcomes: [],
  };
  try {
    const autoRetryDeps = makeAutoRetryFailedBatchesDeps(tenant.slug);
    batchSweep = await sweepAutoRetryFailedBatches(autoRetryDeps, {
      tenantId: tenant,
      requestId: null,
    });
    if (batchSweep.errorCount > 0) {
      logger.warn(
        {
          tenantId: tenant.slug,
          batchSweep: {
            eligible: batchSweep.eligibleCount,
            retried: batchSweep.retriedCount,
            errored: batchSweep.errorCount,
          },
        },
        'cron.broadcasts.reconcile.batch_auto_retry_partial_failure',
      );
    }
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenant.slug,
      },
      'cron.broadcasts.reconcile.batch_auto_retry_threw',
    );
  }

  // Ship-blocker A — batch-completion roll-up. Finds `sending` broadcasts
  // split into batches and, for the ones whose batches are all done,
  // transitions sending → sent (+ quota) or → partially_sent (≥1 failed
  // batch). Runs AFTER the auto-retry sweep so a just-re-queued batch is
  // re-evaluated as in-progress (no premature roll-up). Best-effort +
  // per-item guarded inside the sweep.
  let rollUp: Awaited<ReturnType<typeof sweepBatchCompletion>> = {
    scanned: 0,
    sentCount: 0,
    partialCount: 0,
    inProgressCount: 0,
    errorCount: 0,
  };
  try {
    rollUp = await sweepBatchCompletion(
      makeRollUpBatchBroadcastDeps(tenant.slug),
      { requestId: null },
    );
    if (
      rollUp.sentCount > 0 ||
      rollUp.partialCount > 0 ||
      rollUp.errorCount > 0
    ) {
      logger.info(
        { tenantId: tenant.slug, rollUp },
        'cron.broadcasts.reconcile.batch_completion_rollup',
      );
    }
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e.message : String(e), tenantId: tenant.slug },
      'cron.broadcasts.reconcile.batch_rollup_threw',
    );
  }

  // Phase 3F.11.16 (Round 1 F-15 observability sweep — pulled forward
  // from F7.1a.1 backlog per user directive). F71A US1 dispatch-broadcast-
  // batch.ts:312 has a known forensic-only failure mode: Resend acknowledged
  // the broadcast but our `updateStatus(providerBroadcastId=...)` persist
  // failed. The batch row is stuck in `sending` with NULL provider_broadcast_id;
  // the webhook can never route events to it. Phase 3F.11.1 C4 wrap +
  // logger.error covers the forensic audit emit failure; this sweep covers
  // the residual "row still NULL > 10 min later" gap so ops can see the
  // accumulation rate and decide whether to dashboard-build a Resend
  // dashboard backfill workflow (F7.1a.1 feature work).
  //
  // No auto-backfill — that requires Resend "list broadcasts by metadata"
  // dashboard query which is a separate feature; this sweep is OBSERVABILITY
  // ONLY. Warns at sustained rate > 5/tick = real ops attention needed.
  let orphanedProviderIdCount = 0;
  try {
    const orphanRows = await runInTenant(tenant, async (tx) => {
      const result = (await tx.execute(sql`
        SELECT id, broadcast_id::text AS broadcast_id, batch_index
        FROM broadcast_batch_manifests
        WHERE tenant_id = ${tenant.slug}
          AND status = 'sending'
          AND provider_broadcast_id IS NULL
          AND updated_at < now() - interval '10 minutes'
        ORDER BY updated_at ASC
        LIMIT 50
      `)) as unknown as Array<{
        id: string;
        broadcast_id: string;
        batch_index: number;
      }>;
      return result;
    });
    orphanedProviderIdCount = orphanRows.length;
    if (orphanedProviderIdCount > 0) {
      // Log each row at warn level (capped at 50 per tick to bound
      // pino volume). Ops dashboards plot orphanedProviderIdCount over
      // time; sustained > 5/tick is the alert threshold (manual ops
      // backfill via Resend dashboard required).
      for (const row of orphanRows) {
        logger.warn(
          {
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
            batchManifestId: row.id,
            batchIndex: row.batch_index,
          },
          'cron.broadcasts.reconcile.batch_manifest_provider_id_orphan',
        );
      }
    }
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenant.slug,
      },
      'cron.broadcasts.reconcile.orphan_sweep_failed',
    );
  }

  logger.info(
    {
      tenantId: tenant.slug,
      ...summary,
      batch_auto_retry_eligible: batchSweep.eligibleCount,
      batch_auto_retry_retried: batchSweep.retriedCount,
      batch_auto_retry_errors: batchSweep.errorCount,
      // Phase 3F.11.16 — F-15 observability sweep result.
      orphaned_provider_id_count: orphanedProviderIdCount,
    },
    'cron.broadcasts.reconcile.tick_complete',
  );

  // Review ERR-H-R3-2 (round 3): split escalation between "harness
  // should retry" (uncaught_error / server_error → 500) and
  // "operator should look but harness MUST NOT retry"
  // (gateway_error → 200 + dedicated alert log). cron-job.org retries
  // 500 responses; returning 500 on a Resend outage caused duplicate
  // reconcile attempts every retry tick (the per-row work was already
  // done idempotently — the 500 just wasted compute and emitted
  // duplicate audit rows). The next 15-min tick is the natural retry.
  if (summary.gateway_error > 0) {
    logger.error(
      {
        tenantId: tenant.slug,
        gateway_error: summary.gateway_error,
        processed: summary.processed,
        // dedupeKey lets the alert pipeline coalesce a Resend-outage
        // burst into one alert per tenant per outage window.
        dedupeKey: `f7-reconcile-gateway-error:${tenant.slug}`,
      },
      'cron.broadcasts.reconcile.gateway_outage',
    );
  }

  // Programmer bugs + use-case server errors → harness retry is
  // appropriate (transient DB blip, in-process state issue). Per-row
  // try/catch already logged + audited each row; this 500 is the
  // tick-level escalation hook for cron-job.org dashboard.
  const responseBody = {
    ...summary,
    batch_auto_retry: {
      eligible: batchSweep.eligibleCount,
      retried: batchSweep.retriedCount,
      errored: batchSweep.errorCount,
    },
  };
  if (summary.uncaught_error > 0 || summary.server_error > 0) {
    return NextResponse.json(responseBody, { status: 500 });
  }
  return NextResponse.json(responseBody, { status: 200 });
}
