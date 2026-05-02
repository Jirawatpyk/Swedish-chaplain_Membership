/**
 * T172 (Phase 9) — F7 broadcasts gauges metric trigger (external
 * cron-job.org handler).
 *
 * Emits two gauges per tenant per 5-min tick:
 *   - `broadcasts.queue_pending{tenant}` — count of `status IN
 *     ('submitted','approved')` rows; alert > 8000 (FR-013 SLA risk)
 *   - `broadcasts.stuck_sending_count{tenant}` — count of
 *     `status='sending' AND sending_started_at < now() - 24h` rows;
 *     any non-zero alarms (webhook event lost / Resend resource missing)
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
      return { pendingRows, stuckRows };
    });
    pending = Array.from(result.pendingRows);
    stuck = Array.from(result.stuckRows);
  } catch (e) {
    logger.error(
      { requestId, err: e instanceof Error ? e.message : String(e) },
      'cron.broadcasts_gauges.query_failed',
    );
    return NextResponse.json({ error: 'query_failed' }, { status: 500 });
  }

  let pendingTotal = 0;
  let stuckTotal = 0;
  for (const row of pending) {
    broadcastsMetrics.queuePending(row.tenant_id, row.count);
    pendingTotal += row.count;
  }
  for (const row of stuck) {
    broadcastsMetrics.stuckSendingCount(row.tenant_id, row.count);
    stuckTotal += row.count;
  }

  logger.info(
    {
      requestId,
      pendingTenantCount: pending.length,
      stuckTenantCount: stuck.length,
      pendingTotal,
      stuckTotal,
      stuckHours: STUCK_SENDING_HOURS,
    },
    'cron.broadcasts_gauges.completed',
  );

  return NextResponse.json(
    {
      ok: true,
      pendingTenantCount: pending.length,
      stuckTenantCount: stuck.length,
      pendingTotal,
      stuckTotal,
      stuckHours: STUCK_SENDING_HOURS,
    },
    { status: 200 },
  );
}
