/**
 * T172 (Phase 9) — F7 broadcasts gauges metric trigger (external
 * cron-job.org handler).
 *
 * Emits three gauges per tenant per 5-min tick:
 *   - `broadcasts.queue_pending{tenant}` — count of `status IN
 *     ('submitted','approved')` rows; alert > 8000 (FR-013 SLA risk)
 *   - `broadcasts.stuck_sending_count{tenant}` — count of
 *     `status='sending' AND sending_started_at < now() - 24h` rows;
 *     any non-zero alarms (webhook event lost / Resend resource missing)
 *   - `broadcasts.dispatch_failure_rate{tenant}` — Round 3 G1+G5
 *     fix — rolling 1h ratio of `failed_to_dispatch` over the union of
 *     dispatched statuses, alert > 0.10 → page (Resend incident).
 *     Tenants with zero rolling-window traffic are NOT sampled (no
 *     false-positive zeros from quiet chambers).
 *
 * Same external-cron pattern as F5 `stale-pending-count`: cron-job.org
 * fires every 5 min with `Authorization: Bearer CRON_SECRET`.
 *
 * Configuration: see `docs/runbooks/cron-jobs.md` for the runbook entry.
 * Without this trigger the gauges stay at 0 and the alerts never fire.
 *
 * Idempotent: GET-only, read-only. Re-running emits identical samples.
 * Runtime: Node.js. Force-dynamic to skip Next cache.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STUCK_SENDING_HOURS = 24;

interface PendingRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly count: number;
}

interface DispatchRatioRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly failed: number;
  readonly dispatched: number;
}

const DISPATCH_FAILURE_WINDOW_HOURS = 1;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  const authHeader = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (expected) {
    if (!verifyCronBearer(authHeader, expected)) {
      logger.warn({ requestId }, 'cron.broadcasts_gauges.unauthorized');
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  } else if (!env.isDevelopment) {
    logger.error({ requestId }, 'cron.broadcasts_gauges.no_secret_configured');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let pending: PendingRow[];
  let stuck: PendingRow[];
  let dispatchRatios: DispatchRatioRow[];
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      const pendingRows = await tx.execute<PendingRow>(sql`
        SELECT tenant_id, COUNT(*)::int AS count
        FROM broadcasts
        WHERE status::text IN ('submitted', 'approved')
        GROUP BY tenant_id
      `);
      const stuckRows = await tx.execute<PendingRow>(sql`
        SELECT tenant_id, COUNT(*)::int AS count
        FROM broadcasts
        WHERE status::text = 'sending'
          AND sending_started_at IS NOT NULL
          AND sending_started_at < now() - (${STUCK_SENDING_HOURS} || ' hours')::interval
        GROUP BY tenant_id
      `);
      // Round 3 observability G1+G5 — rolling 1h dispatch failure rate
      // per tenant. Window keyed on `sending_started_at` because that
      // column is set when the use-case enters the dispatch path and
      // remains populated through both `failed_to_dispatch` and `sent`
      // terminal states (verified in drizzle-broadcasts-repo.ts —
      // status flips don't clear the timestamp). Tenants with zero
      // rolling-window traffic produce no row → gauge unsampled (safe
      // for OTel; no false-positive zeros).
      const dispatchRows = await tx.execute<DispatchRatioRow>(sql`
        SELECT
          tenant_id,
          COUNT(*) FILTER (WHERE status::text = 'failed_to_dispatch')::int AS failed,
          COUNT(*) FILTER (WHERE status::text IN ('failed_to_dispatch', 'sent', 'sending'))::int AS dispatched
        FROM broadcasts
        WHERE sending_started_at IS NOT NULL
          AND sending_started_at > now() - (${DISPATCH_FAILURE_WINDOW_HOURS} || ' hours')::interval
        GROUP BY tenant_id
        HAVING COUNT(*) FILTER (WHERE status::text IN ('failed_to_dispatch', 'sent', 'sending')) > 0
      `);
      return { pendingRows, stuckRows, dispatchRows };
    });
    pending = Array.from(result.pendingRows);
    stuck = Array.from(result.stuckRows);
    dispatchRatios = Array.from(result.dispatchRows);
  } catch (e) {
    logger.error(
      { requestId, err: e instanceof Error ? e.message : String(e) },
      'cron.broadcasts_gauges.query_failed',
    );
    return NextResponse.json({ error: 'query_failed' }, { status: 500 });
  }

  let pendingTotal = 0;
  let stuckTotal = 0;
  let dispatchRatioMaxBps = 0; // basis points — 0..10000
  for (const row of pending) {
    broadcastsMetrics.queuePending(row.tenant_id, row.count);
    pendingTotal += row.count;
  }
  for (const row of stuck) {
    broadcastsMetrics.stuckSendingCount(row.tenant_id, row.count);
    stuckTotal += row.count;
  }
  for (const row of dispatchRatios) {
    // dispatched > 0 enforced by HAVING clause — division safe.
    const rate = row.failed / row.dispatched;
    broadcastsMetrics.dispatchFailureRate(row.tenant_id, rate);
    const bps = Math.round(rate * 10_000);
    if (bps > dispatchRatioMaxBps) dispatchRatioMaxBps = bps;
  }

  logger.info(
    {
      requestId,
      pendingTenantCount: pending.length,
      stuckTenantCount: stuck.length,
      dispatchRatioTenantCount: dispatchRatios.length,
      pendingTotal,
      stuckTotal,
      dispatchRatioMaxBps,
      stuckHours: STUCK_SENDING_HOURS,
      dispatchWindowHours: DISPATCH_FAILURE_WINDOW_HOURS,
    },
    'cron.broadcasts_gauges.completed',
  );

  return NextResponse.json(
    {
      ok: true,
      pendingTenantCount: pending.length,
      stuckTenantCount: stuck.length,
      dispatchRatioTenantCount: dispatchRatios.length,
      pendingTotal,
      stuckTotal,
      dispatchRatioMaxBps,
      stuckHours: STUCK_SENDING_HOURS,
      dispatchWindowHours: DISPATCH_FAILURE_WINDOW_HOURS,
    },
    { status: 200 },
  );
}
