/**
 * F7 US2 cron worker — POST `/api/cron/broadcasts/dispatch-scheduled`.
 *
 * Triggered every 5 min by cron-job.org (per docs/runbooks/cron-jobs.md).
 *
 * Auth: Bearer token via `CRON_SECRET` (matches F4 outbox-dispatch).
 *
 * Concurrency model (review C2 — 2026-04-30; clarified post-staff-review
 * 2026-05-01):
 *   - Eligible-row scan uses `FOR UPDATE SKIP LOCKED` to skip rows
 *     ALREADY held by another concurrent scan. **The row lock is
 *     released the moment `runInTenant` returns** (tx ends at line 69),
 *     so SKIP LOCKED only protects against two ticks racing to read the
 *     SAME eligibility batch — it does NOT protect the per-row dispatch
 *     window against another tick that arrives after this one's tx
 *     ended but before the dispatch use-case's own tx starts.
 *   - The authoritative dispatch-time concurrency guard is the per-row
 *     `pg_advisory_xact_lock('broadcasts:'+tenant+':'+id)` acquired
 *     inside the use-case's `withTx` — that lock survives the entire
 *     dispatch tx and is what closes the TOCTOU window between cron +
 *     manual admin send-now. SKIP LOCKED here is a small additional
 *     defence against eligible-scan duplication, not the primary guard.
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
import { verifyCronBearer } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { broadcastsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

const MAX_PER_TICK = 50;

// Parity with reconcile + prune cron routes: pin Node.js runtime
// explicitly. verifyCronBearer + Drizzle/Neon + advisory locks all
// require Node APIs (node:crypto, pg net socket); a future Edge default
// would silently break dispatch.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Verify-fix R3 (Code-M2, 2026-05-02): constant-time Bearer check
  // via shared `verifyCronBearer` helper (matches F4 outbox + F5
  // sweep-stale-pending-refunds). Avoids timing side-channel.
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

  // Verify-fix R3 (Errors-H2, 2026-05-02): kill-switch check — without
  // this, a feature-flag rollback would NOT stop in-flight `approved`
  // broadcasts from going out (cron picks them up, calls Resend, sends
  // real emails, consumes member quota). Returns 200 + {skipped:true}
  // so cron-job.org does NOT retry-storm a dark-launch period.
  if (!env.features.f7Broadcasts) {
    logger.info(
      { tenantId: tenant.slug },
      'cron.broadcasts.dispatch.feature_disabled',
    );
    broadcastsMetrics.cronSkippedCount(tenant.slug, 'kill_switch');
    return NextResponse.json(
      { skipped: true, reason: 'feature_disabled' },
      { status: 200 },
    );
  }

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

  // T172 — emit no-due-rows skip when query returned an empty set so
  // the cron tick observability dashboard can distinguish "queue
  // empty" from "feature_disabled" / "advisory_lock_held".
  if (eligible.length === 0) {
    broadcastsMetrics.cronSkippedCount(tenant.slug, 'no_due_rows');
  }

  // T174 — root span `cron_dispatch_scheduled` per docs § 22 trace tree.
  // The span wraps the entire eligible-row loop so per-broadcast
  // dispatch sub-spans (created inside the use-case via Drizzle/fetch
  // auto-instr) hang as children of this root.
  const cronSpan = broadcastsTracer().startSpan('cron_dispatch_scheduled', {
    attributes: {
      'tenant.id': tenant.slug,
      'cron.eligible_count': eligible.length,
    },
  });

  const deps = await makeDispatchScheduledBroadcastDeps(tenant.slug);
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
  cronSpan.setAttribute('cron.processed', summary.processed);
  cronSpan.setAttribute('cron.succeeded', summary.succeeded);
  if (summary.uncaught_error > 0 || summary.unknown_error > 0) {
    cronSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: `errors: uncaught=${summary.uncaught_error} unknown=${summary.unknown_error}`,
    });
  }
  cronSpan.end();
  return NextResponse.json(summary, { status: 200 });
}
