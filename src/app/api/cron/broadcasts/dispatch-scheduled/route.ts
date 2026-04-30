/**
 * F7 US2 cron worker — POST `/api/cron/broadcasts/dispatch-scheduled`.
 *
 * Triggered every 5 min by cron-job.org (per docs/runbooks/cron-jobs.md).
 *
 * Auth: Bearer token via `CRON_SECRET` (matches F4 outbox-dispatch).
 *
 * Iterates `broadcasts` rows in tenant where status='approved' AND
 * scheduledFor <= now(). Calls `dispatchScheduledBroadcast` per row.
 * Returns aggregate summary.
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
import { db } from '@/lib/db';
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

  // Eligible-row pick happens against `db` (no RLS in cron context — the
  // route runs as cron, not chamber_app). Per-row dispatch then enters
  // tenant-scoped tx via the use-case's broadcastsRepo.withTx.
  let eligible: ReadonlyArray<{ broadcast_id: string }>;
  try {
    eligible = (await db.execute(sql`
      SELECT broadcast_id::text AS broadcast_id
      FROM broadcasts
      WHERE tenant_id = ${tenantCtx.slug}
        AND status = 'approved'
        AND scheduled_for IS NOT NULL
        AND scheduled_for <= now()
      ORDER BY scheduled_for ASC
      LIMIT ${MAX_PER_TICK}
    `)) as unknown as Array<{ broadcast_id: string }>;
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantCtx.slug,
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
    skipped: 0,
  };

  const deps = makeDispatchScheduledBroadcastDeps(tenantCtx.slug);
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
              tenantId: tenantCtx.slug,
              broadcastId: row.broadcast_id,
              reason: result.error.reason,
            },
            'cron.broadcasts.dispatch.retryable',
          );
          break;
        case 'broadcast_failed_to_dispatch':
        case 'broadcast_audience_post_suppression_empty':
          summary.permanent_failed++;
          break;
        default:
          summary.skipped++;
      }
    } catch (e) {
      summary.permanent_failed++;
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: tenantCtx.slug,
          broadcastId: row.broadcast_id,
        },
        'cron.broadcasts.dispatch.uncaught_error',
      );
    }
  }

  logger.info(
    { tenantId: tenantCtx.slug, ...summary },
    'cron.broadcasts.dispatch.tick_complete',
  );
  return NextResponse.json(summary, { status: 200 });
}
