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
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

const MAX_PER_TICK = 50;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

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
  //
  // 108 Phase 9 review round 1 (S22) — the query below used to exclude any
  // broadcast holding a `broadcast_batch_manifests` row. That exclusion existed
  // because a batched broadcast carries NULL `resend_broadcast_id` on the parent
  // row, so this single-audience reconcile would have wrongly failed it, and its
  // stated justification was that "their completion is the batch-completion
  // roll-up below". `ca51f59a1` deleted that roll-up along with the batch path,
  // which turned the exclusion into a DEAD END: an excluded row was reconciled
  // by nothing at all and would sit in `sending` for ever.
  //
  // Removed rather than left in place. Nothing writes a manifest any more and
  // prod has zero rows in that table (the batch path was never flag-enabled), so
  // there is nothing left to protect against — and a historical row, if one ever
  // surfaced, is better reconciled here than abandoned by half a mechanism.
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
          -- NOTE: a NOT EXISTS exclusion over broadcast_batch_manifests used to
          -- sit here; it was REMOVED in 108 Phase 9 review round 1 (S22). See
          -- the docblock above this query for why. (Deliberately no backticks
          -- in SQL comments: this string is a sql tagged template, and one
          -- backtick closes it — the compiler error lands lines away.)
        ORDER BY sending_started_at ASC
        LIMIT ${MAX_PER_TICK}
        FOR UPDATE SKIP LOCKED
      `)) as unknown as Array<{ broadcast_id: string }>;
      return rows;
    });
  } catch (e) {
    logger.error(
      {
        err: errKind(e),
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
    // 2026-09-10 follow-up (1) — present at Resend but NOT `sent`; the use
    // case decided nothing and an operator has to. Counted apart from the two
    // decided outcomes so a tick summary of "sent=0, missing=0" can no longer
    // read as "nothing to do" while a row is being reported for a human.
    unresolved_provider_status: 0,
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
              // Reliability review L-5 (2026-09-10) — was `message:
              // result.error.message`, which is `e.message` from the use case's
              // outer catch: a `NeonDbError` there carries bound parameters, on
              // this module member addresses, and `message` is not a
              // REDACT_PATH. Same class round 4 L3 fixed on the dispatch route;
              // this one was missed. The class is the bounded half.
              errClass: result.error.errClass ?? 'unclassified',
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
        case 'unresolved_provider_status':
          summary.unresolved_provider_status++;
          // The use case already logged at critical with the status word and
          // counted the metric; this line is the cron-level correlation (the
          // tick summary below carries the count, not the id).
          logger.warn(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              observedResendStatus: result.value.observedResendStatus,
            },
            'cron.broadcasts.reconcile.unresolved_provider_status',
          );
          break;
        case 'not_stuck_yet':
          summary.not_stuck_yet++;
          break;
        case 'broadcast_not_found':
          summary.not_found++;
          break;
        default: {
          // A new outcome kind without an arm here would be counted nowhere —
          // the exact shape that let `import_submitted` read as a success on the
          // dispatch cron until it got its own bucket. `void`, never `return
          // _exhaustive`: that idiom returns the VALUE at runtime.
          const _exhaustive: never = result.value;
          void _exhaustive;
          summary.uncaught_error++;
          logger.error(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              outcomeKind: (result.value as { kind?: string }).kind ?? 'unknown',
            },
            'cron.broadcasts.reconcile.unknown_outcome_kind',
          );
        }
      }
    } catch (e) {
      summary.uncaught_error++;
      logger.error(
        {
          err: errKind(e),
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

  // The batch path was removed in 108 US5, and with it three sweeps that used
  // to live here: per-batch auto-retry, batch completion roll-up, and the
  // orphaned-provider-id observability scan over `broadcast_batch_manifests`.
  // A broadcast is now either single-audience (the MVP push) or import-built,
  // and both are reconciled by the loop above.

  logger.info(
    { tenantId: tenant.slug, ...summary },
    'cron.broadcasts.reconcile.tick_complete',
  );

  // Review ERR-H-R3-2 (round 3): split escalation between "harness should
  // retry" (uncaught_error / server_error → 500) and "operator should look but
  // the harness MUST NOT retry" (gateway_error → 200 + a dedicated alert log).
  // Returning 500 on a Resend outage caused duplicate reconcile attempts every
  // retry tick; the per-row work was already idempotent, so the 500 only wasted
  // compute. The next 15-minute tick is the natural retry.
  if (summary.gateway_error > 0) {
    logger.error(
      {
        tenantId: tenant.slug,
        gateway_error: summary.gateway_error,
        processed: summary.processed,
        // Lets the alert pipeline coalesce a Resend-outage burst into one
        // alert per tenant per outage window.
        dedupeKey: `f7-reconcile-gateway-error:${tenant.slug}`,
      },
      'cron.broadcasts.reconcile.gateway_outage',
    );
  }

  const responseBody = { ...summary };
  if (summary.uncaught_error > 0 || summary.server_error > 0) {
    return NextResponse.json(responseBody, { status: 500 });
  }
  return NextResponse.json(responseBody, { status: 200 });
}
