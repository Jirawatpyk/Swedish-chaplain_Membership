/**
 * Money-remediation Task 1 — unreconciled `processor_events` gauge trigger.
 *
 * Plan authority: `.superpowers/reviews/money-remediation-plan.md` Task 1.
 * Runbook: `docs/runbooks/unprocessed-events-count.md`.
 *
 * **What it watches.** A Stripe webhook that reaches the dispatcher inserts
 * its `processor_events` row with `outcome='processed'` in its own step-6 tx
 * (`process-webhook-event.ts:374`), and sets `processed_at` only at the tail
 * of the dispatch tx (`markProcessed`). A row that is still
 * `outcome='processed' AND processed_at IS NULL` well after ingest therefore
 * means: the dispatcher started, something committed or was declined
 * mid-flight, and the event was never marked reconciled.
 *
 * That is the F-1 divergence shape, and until this route existed **nothing
 * measured it**. `sweepStalePendingRefunds` scans `refunds`; the payments
 * stale-pending gauge scans `payments`; neither looks at `processor_events`.
 * Worse, the F-1 path answers Stripe 200, so Stripe never redelivers — the
 * row simply sits there.
 *
 * **Why the `outcome` predicate is not optional.** Three row classes are
 * `processed_at IS NULL` permanently and BY DESIGN:
 *   - `acknowledged_only` from the unknown-processor-account branch
 *     (`api/webhooks/stripe/route.ts:608`) — 200-acked, nothing to process.
 *   - `rejected_signature` / `rejected_environment_mismatch` /
 *     `rejected_api_version_mismatch` — rejection-audit rows, never dispatched.
 * Counting them pins the gauge at a large non-zero constant (135 such rows on
 * the dev branch at the time of writing) and destroys the property that makes
 * this instrument worth deploying: production reads 0 today, so any future
 * non-zero is unambiguously new.
 *
 * (The unknown-EVENT-TYPE `acknowledged_only` branch sets `outcome` and
 * `processed_at` in one tx, so it is excluded either way. If THAT tx were to
 * fail, its row would be indistinguishable from an unknown-account row — but
 * that path returns a transient `dispatch_failed`, so Stripe retries it and
 * it self-heals. Documented blind spot, not a silent one.)
 *
 * **Scheduling**: native Vercel Cron (GET-only, UTC), 5-minute cadence,
 * mirroring the sibling `stale-pending-count` route. Vercel injects the
 * `CRON_SECRET` Bearer.
 *
 * Idempotent: GET-only, read-only. Re-running emits identical samples.
 *
 * Runtime: Node.js (Drizzle + OTel). Force-dynamic to skip Next cache — the
 * gauge MUST reflect current DB state.
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

/**
 * Grace window before an unmarked row is considered unreconciled rather than
 * in-flight. A webhook dispatch that is genuinely mid-flight (F4 PDF render +
 * Blob upload inside the tx) can legitimately take tens of seconds; 15 minutes
 * is comfortably past any healthy dispatch and still far inside the 5-minute
 * alert cadence's usefulness.
 */
const UNPROCESSED_AGE_MINUTES = 15;

/**
 * Label used when `processor_events.tenant_id` is NULL. The column is
 * nullable by design (rows are inserted during the pre-tenant-resolution
 * webhook window), so these groups are real and must be reported, not
 * dropped. Matches the existing `webhookReceiveCount` convention.
 */
const UNRESOLVED_TENANT = 'unresolved';

interface UnprocessedRow extends Record<string, unknown> {
  readonly tenant_id: string | null;
  readonly count: number;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn({ requestId }, 'cron.unprocessed_events_count.unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Cross-tenant ops aggregate gated by CRON_SECRET, not a user request —
  // deliberately not run through `runInTenant`. Raw SQL for the GROUP BY,
  // matching the sibling stale-pending-count route.
  let rows: UnprocessedRow[];
  try {
    // Cap wall-clock at 10s so a pathological scan fails fast rather than
    // holding a Vercel function slot to the 30s platform limit. SET LOCAL is
    // tx-scoped, hence the wrapping transaction.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      return await tx.execute<UnprocessedRow>(sql`
        SELECT tenant_id, COUNT(*)::int AS count
        FROM processor_events
        WHERE processed_at IS NULL
          AND outcome = 'processed'
          AND created_at < now() - (${UNPROCESSED_AGE_MINUTES} || ' minutes')::interval
        GROUP BY tenant_id
      `);
    });
    rows = Array.from(result);
  } catch (e) {
    // constructor name only — Postgres error messages carry SQL params and
    // table/column names (forbidden-fields hygiene, matching the sibling
    // route's F5R2-H3 fix).
    logger.error(
      { requestId, errKind: e instanceof Error ? e.constructor.name : 'unknown' },
      'cron.unprocessed_events_count.query_failed',
    );
    return NextResponse.json({ error: 'query_failed' }, { status: 500 });
  }

  const tenants = rows.map((r) => ({
    tenantId: r.tenant_id ?? UNRESOLVED_TENANT,
    count: r.count,
  }));

  let totalUnprocessed = 0;
  for (const t of tenants) {
    paymentsMetrics.unprocessedEventsCount(t.tenantId, t.count);
    totalUnprocessed += t.count;
  }

  logger.info(
    {
      requestId,
      tenantCount: tenants.length,
      totalUnprocessed,
      ageMinutes: UNPROCESSED_AGE_MINUTES,
    },
    'cron.unprocessed_events_count.completed',
  );

  return NextResponse.json(
    {
      ok: true,
      tenantCount: tenants.length,
      totalUnprocessed,
      ageMinutes: UNPROCESSED_AGE_MINUTES,
      tenants,
    },
    { status: 200 },
  );
}
