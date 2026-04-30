/**
 * F7 US2 cron worker — POST `/api/cron/broadcasts/dispatch-scheduled`.
 *
 * Triggered every 5 min by cron-job.org (per docs/runbooks/cron-jobs.md).
 *
 * Auth: Bearer token via `CRON_SECRET` (matches F4 outbox-dispatch).
 *
 * Concurrency model (review C2 — 2026-04-30):
 *   - Eligible-row scan uses `FOR UPDATE SKIP LOCKED` so two overlapping
 *     ticks (cron-job.org retry storm or 5-min cadence collision)
 *     CANNOT both grab the same broadcast.
 *   - Per-row dispatch enters tenant-scoped tx via the use-case which
 *     internally acquires `pg_advisory_xact_lock('broadcasts:'+tenant+':'+id)`
 *     — closes the TOCTOU window between cron + manual admin send-now.
 *
 * RLS context: the eligible scan runs with `runInTenant(tenant.slug)` so
 * RLS+FORCE policies apply (Constitution Principle I clause 1 — every
 * read goes through tenant isolation, even cron paths).
 *
 * Single-tenant SweCham MVP — runs against the deployed tenant slug.
 * Future SaaS multi-tenant: iterate tenant catalogue (deferred to F10).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import {
  asBroadcastId,
  dispatchScheduledBroadcast,
  makeDispatchScheduledBroadcastDeps,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const MAX_PER_TICK = 50;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${env.cron.secret}`) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

  // Eligible-row pick goes through `runInTenant` so RLS+FORCE applies
  // (cron-system context). `FOR UPDATE SKIP LOCKED` prevents two ticks
  // grabbing the same row — the second tick's transaction will skip
  // any row whose advisory lock is held by an in-flight worker.
  let eligible: ReadonlyArray<{ broadcast_id: string }>;
  try {
    eligible = await runInTenant(tenant, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT broadcast_id::text AS broadcast_id
        FROM broadcasts
        WHERE tenant_id = ${tenant.slug}
          AND status = 'approved'
          AND scheduled_for IS NOT NULL
          AND scheduled_for <= now()
        ORDER BY scheduled_for ASC
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
      'cron.broadcasts.dispatch.eligible_query_failed',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  const summary = {
    processed: 0,
    succeeded: 0,
    retryable: 0,
    permanent_failed: 0,
    resource_missing: 0,
    unknown_error: 0,
    uncaught_error: 0,
  };

  const deps = makeDispatchScheduledBroadcastDeps(tenant.slug);
  for (const row of eligible) {
    summary.processed++;
    try {
      const result = await dispatchScheduledBroadcast(deps, {
        broadcastId: asBroadcastId(row.broadcast_id),
      });
      if (result.ok) {
        summary.succeeded++;
        continue;
      }
      switch (result.error.kind) {
        case 'gateway_retryable':
          summary.retryable++;
          logger.warn(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              subKind: result.error.subKind,
              reason: result.error.reason,
            },
            'cron.broadcasts.dispatch.retryable',
          );
          break;
        case 'broadcast_resend_resource_missing':
          summary.resource_missing++;
          logger.error(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              resourceType: result.error.resourceType,
              resourceId: result.error.resourceId,
            },
            'cron.broadcasts.dispatch.resend_resource_missing',
          );
          break;
        case 'broadcast_failed_to_dispatch':
        case 'broadcast_audience_post_suppression_empty':
          summary.permanent_failed++;
          break;
        default: {
          // Round-4 HIGH-D + Round-5 R5-CRON — unknown error kind goes
          // to the dedicated `unknown_error` counter (was the
          // benign-sounding `skipped` bucket; renamed so dashboards
          // alert on the right class).
          summary.unknown_error++;
          const errKind = (result.error as { kind?: string }).kind ?? 'unknown';
          logger.error(
            {
              tenantId: tenant.slug,
              broadcastId: row.broadcast_id,
              errorKind: errKind,
            },
            'cron.broadcasts.dispatch.unknown_error_kind',
          );
        }
      }
    } catch (e) {
      // Review #13: uncaught throws (e.g., programming bugs) must be
      // distinguishable from handled permanent failures so dashboards
      // alert on the right class. The broadcast row stays 'approved'
      // but the next tick will hit the same bug — alert immediately.
      summary.uncaught_error++;
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
          tenantId: tenant.slug,
          broadcastId: row.broadcast_id,
        },
        'cron.broadcasts.dispatch.uncaught_error',
      );
    }
  }

  logger.info(
    { tenantId: tenant.slug, ...summary },
    'cron.broadcasts.dispatch.tick_complete',
  );
  return NextResponse.json(summary, { status: 200 });
}
