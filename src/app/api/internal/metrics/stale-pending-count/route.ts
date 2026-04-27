/**
 * T138 — Stale-pending-count metric trigger (external cron-job.org handler).
 *
 * Plan authority: `specs/009-online-payment/plan.md` § VII.Metrics —
 * `payments.stale_pending_count{tenant}` gauge surfaces Stripe-webhook-giveup
 * zombies (rows where `status='pending'` AND `initiated_at < now() - 24h`).
 *
 * **Why external cron-job.org rather than Vercel Cron**:
 * Vercel Hobby plan caps native crons at once-per-day, which is incompatible
 * with the 5-min cadence this gauge needs. cron-job.org fires every 5 minutes
 * with `Authorization: Bearer CRON_SECRET` against this route. Configuration
 * lives in `docs/runbooks/stale-pending-count.md` so re-creation is reproducible
 * if the external account is lost.
 *
 * **Without this trigger** the gauge stays at 0 and the alert never fires —
 * the cron-job.org entry is mandatory, not optional.
 *
 * Idempotent: GET-only, read-only. Re-running emits identical samples.
 *
 * Runtime: Node.js (Drizzle + OTel). Force-dynamic to skip Next cache —
 * the gauge MUST reflect current DB state.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { paymentsMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_HOURS = 24;

interface StaleRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly count: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  const authHeader = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (expected) {
    if (!verifyCronBearer(authHeader, expected)) {
      logger.warn(
        { requestId },
        'cron.stale_pending_count.unauthorized',
      );
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  } else if (!env.isDevelopment) {
    logger.error(
      { requestId },
      'cron.stale_pending_count.no_secret_configured',
    );
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Aggregate across tenants in a single query — bypasses per-tenant RLS
  // intentionally (this is a cross-tenant ops gauge gated by CRON_SECRET,
  // not a user request). Uses raw SQL for the GROUP BY because Drizzle's
  // typed builder is more verbose for one-off cross-tenant aggregates.
  let rows: StaleRow[];
  try {
    const result = await db.execute<StaleRow>(sql`
      SELECT tenant_id, COUNT(*)::int AS count
      FROM payments
      WHERE status = 'pending'
        AND initiated_at < now() - (${STALE_HOURS} || ' hours')::interval
      GROUP BY tenant_id
    `);
    rows = Array.from(result);
  } catch (e) {
    logger.error(
      { requestId, err: e instanceof Error ? e.message : String(e) },
      'cron.stale_pending_count.query_failed',
    );
    return NextResponse.json({ error: 'query_failed' }, { status: 500 });
  }

  let totalEmitted = 0;
  for (const row of rows) {
    paymentsMetrics.stalePendingCount(row.tenant_id, row.count);
    totalEmitted += row.count;
  }

  logger.info(
    {
      requestId,
      tenantCount: rows.length,
      totalEmitted,
      staleHours: STALE_HOURS,
    },
    'cron.stale_pending_count.completed',
  );

  return NextResponse.json(
    {
      ok: true,
      tenantCount: rows.length,
      totalEmitted,
      staleHours: STALE_HOURS,
      tenants: rows.map((r) => ({ tenantId: r.tenant_id, count: r.count })),
    },
    { status: 200 },
  );
}
