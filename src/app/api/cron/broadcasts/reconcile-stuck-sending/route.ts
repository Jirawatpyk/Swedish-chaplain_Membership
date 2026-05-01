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
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

const MAX_PER_TICK = 50;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${env.cron.secret}`) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }
  if (!env.features.f7Broadcasts) {
    return NextResponse.json(
      { error: { code: 'feature_disabled' } },
      { status: 503 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

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
  for (const row of eligible) {
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
        continue;
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
  }

  logger.info(
    { tenantId: tenant.slug, ...summary },
    'cron.broadcasts.reconcile.tick_complete',
  );
  // Review ERR-M1: surface uncaught-row failures as a non-2xx so the
  // cron-job.org dashboard turns red (the operator-facing alarm signal).
  // The per-row try/catch already logged each error; this is the
  // tick-level escalation hook.
  if (summary.uncaught_error > 0) {
    return NextResponse.json(summary, { status: 500 });
  }
  return NextResponse.json(summary, { status: 200 });
}
