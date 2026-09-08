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

interface TenantRow extends Record<string, unknown> {
  tenant_id: string;
}

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

  let tenants: TenantRow[];
  let pending: PendingRow[];
  let stuck: PendingRow[];
  let dispatchRatios: DispatchRatioRow[];
  let suppressionSizes: PendingRow[];
  let approvedOverdue: PendingRow[];
  let batchNoProgress: PendingRow[];
  let audienceImportStuck: PendingRow[];
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
      // rolling-window traffic produce no row → their label is FORGOTTEN
      // below (re-review finding #2), so the series goes absent rather than
      // freezing at its last value; never a fabricated 0.
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
      // 108 PR-D (staff review P4): the Marketing audience page loads this
      // WHOLE list per request for any `state` filter. It is bounded by TIME,
      // not tenant size, so it is the one input on that page that grows
      // without limit — and it had no signal at all.
      const suppressionRows = await tx.execute<PendingRow>(sql`
        SELECT tenant_id, COUNT(*)::int AS count
        FROM marketing_unsubscribes
        GROUP BY tenant_id
      `);
      // Review 2026-09-07 (errors HIGH-4b) — a broadcast whose audience
      // cannot be built stays `approved` and is retried every tick with NO
      // wall-clock budget; `queue_pending` (alert > 8,000) cannot see one
      // row slipping. Count approved rows more than an hour past schedule.
      const approvedOverdueRows = await tx.execute<PendingRow>(sql`
        SELECT tenant_id, COUNT(*)::int AS count
        FROM broadcasts
        WHERE status::text = 'approved'
          AND scheduled_for IS NOT NULL
          AND scheduled_for < now() - interval '1 hour'
        GROUP BY tenant_id
      `);
      // Review 2026-09-07 round 2 (C9 — errors LOW + observability HIGH) —
      // every tenant with broadcasts is observed, ZERO included. The three
      // count gauges above emit no row for a tenant at zero, and
      // `observeGauge` re-reports the last value at every scrape, so a gauge
      // that once read 1 kept reading 1 after the incident was resolved —
      // the "≥ 1 sustained 30 min" rule on `approved_overdue_count` was a
      // latch, not a level. "0 means 0" (see `forgetAutoInvoiceGauges`).
      // Phase 9b (T144, FR-044 f) — a `sending` broadcast that still holds a
      // `pending` manifest and has retired NONE in the last 30 minutes.
      //
      // `stuck_sending_count` fires at 24 h, which was fine while a batched
      // broadcast was a rarity; with the split threshold at the per-tick batch
      // size a 100-batch send legitimately spends hours in `sending`, so
      // duration stopped being evidence. Progress is: a healthy broadcast
      // retires at least one manifest per 5-minute tick, so 30 minutes with
      // none is six missed ticks.
      const batchNoProgressRows = await tx.execute<PendingRow>(sql`
        SELECT b.tenant_id, COUNT(*)::int AS count
        FROM broadcasts b
        WHERE b.status::text = 'sending'
          AND EXISTS (
            SELECT 1 FROM broadcast_batch_manifests m
            WHERE m.tenant_id = b.tenant_id
              AND m.broadcast_id = b.broadcast_id
              AND m.status::text = 'pending'
          )
          AND NOT EXISTS (
            SELECT 1 FROM broadcast_batch_manifests m2
            WHERE m2.tenant_id = b.tenant_id
              AND m2.broadcast_id = b.broadcast_id
              AND m2.status::text <> 'pending'
              AND m2.updated_at > now() - interval '30 minutes'
          )
        GROUP BY b.tenant_id
      `);
      // T106 (108 US5, FR-044 f) — an audience IMPORT submitted but never
      // completed. `buildAudienceTick` turns such a row terminal, but only on a
      // tick that reaches it; this is the independent signal, and the one
      // number that says "Resend has stopped answering". 30 min matches
      // IMPORT_STUCK_AFTER_MS.
      const audienceImportStuckRows = await tx.execute<PendingRow>(sql`
        SELECT tenant_id, COUNT(*)::int AS count
        FROM broadcasts
        WHERE audience_import_id IS NOT NULL
          AND audience_import_completed_at IS NULL
          AND audience_import_submitted_at < now() - interval '30 minutes'
        GROUP BY tenant_id
      `);
      const tenantRows = await tx.execute<TenantRow>(sql`
        SELECT DISTINCT tenant_id FROM broadcasts
      `);
      return { tenantRows, pendingRows, stuckRows, dispatchRows, suppressionRows, approvedOverdueRows, batchNoProgressRows, audienceImportStuckRows };
    });
    tenants = Array.from(result.tenantRows ?? []);
    pending = Array.from(result.pendingRows);
    stuck = Array.from(result.stuckRows);
    dispatchRatios = Array.from(result.dispatchRows);
    suppressionSizes = Array.from(result.suppressionRows);
    approvedOverdue = Array.from(result.approvedOverdueRows);
    batchNoProgress = Array.from(result.batchNoProgressRows ?? []);
    audienceImportStuck = Array.from(result.audienceImportStuckRows ?? []);
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
  // C9: zero-fill — a tenant absent from a GROUP BY is at 0, and 0 is
  // observed, so a resolved incident clears the gauge on the next tick.
  const pendingByTenant = new Map(pending.map((r) => [r.tenant_id, r.count]));
  const stuckByTenant = new Map(stuck.map((r) => [r.tenant_id, r.count]));
  const overdueByTenant = new Map(approvedOverdue.map((r) => [r.tenant_id, r.count]));
  const noProgressByTenant = new Map(batchNoProgress.map((r) => [r.tenant_id, r.count]));
  const importStuckByTenant = new Map(audienceImportStuck.map((r) => [r.tenant_id, r.count]));
  const suppressionByTenant = new Map(suppressionSizes.map((r) => [r.tenant_id, r.count]));
  const observed = new Set<string>();
  for (const t of [
    ...tenants.map((r) => r.tenant_id),
    ...pendingByTenant.keys(),
    ...stuckByTenant.keys(),
    ...overdueByTenant.keys(),
    ...noProgressByTenant.keys(),
    ...importStuckByTenant.keys(),
    // A tenant can carry unsubscribes with no `broadcasts` row at all (a
    // contact-level opt-out recorded before the first send), so the
    // suppression keys join the observed set rather than relying on it.
    ...suppressionByTenant.keys(),
  ]) {
    observed.add(t);
  }
  let approvedOverdueTotal = 0;
  let batchNoProgressTotal = 0;
  let audienceImportStuckTotal = 0;
  for (const tenantId of observed) {
    const p = pendingByTenant.get(tenantId) ?? 0;
    const s = stuckByTenant.get(tenantId) ?? 0;
    const o = overdueByTenant.get(tenantId) ?? 0;
    broadcastsMetrics.queuePending(tenantId, p);
    broadcastsMetrics.stuckSendingCount(tenantId, s);
    broadcastsMetrics.approvedOverdueCount(tenantId, o);
    const np = noProgressByTenant.get(tenantId) ?? 0;
    broadcastsMetrics.batchNoProgressCount(tenantId, np);
    batchNoProgressTotal += np;
    const ais = importStuckByTenant.get(tenantId) ?? 0;
    broadcastsMetrics.audienceImportStuckCount(tenantId, ais);
    audienceImportStuckTotal += ais;
    pendingTotal += p;
    stuckTotal += s;
    approvedOverdueTotal += o;
  }
  // /code-review 2026-09-07 (finding #6) — the SAME latch class as C9, one
  // loop below the three gauges C9 fixed. `suppressionSizes` comes from a
  // GROUP BY over `marketing_unsubscribes`, so a tenant with no rows emitted
  // no sample and `observeGauge` re-reported its last value forever: a
  // suppression list that is cleared (a data fix, an offboarding) kept
  // reporting its old size. It is a COUNT, so it zero-fills like its three
  // siblings rather than being forgotten like the ratio.
  for (const tenantId of observed) {
    broadcastsMetrics.suppressionListSize(tenantId, suppressionByTenant.get(tenantId) ?? 0);
  }
  const ratioTenants = new Set<string>();
  for (const row of dispatchRatios) {
    // dispatched > 0 enforced by HAVING clause — division safe.
    const rate = row.failed / row.dispatched;
    broadcastsMetrics.dispatchFailureRate(row.tenant_id, rate);
    ratioTenants.add(row.tenant_id);
    const bps = Math.round(rate * 10_000);
    if (bps > dispatchRatioMaxBps) dispatchRatioMaxBps = bps;
  }
  // Re-review 2026-09-07 (finding #2) — the C9 latch class, unclosed in this
  // same function. The ratio query has `HAVING dispatched > 0`, so a quiet
  // tenant emits no row and `observeGauge` re-reports its last value at every
  // scrape: one failed send at 10:00 pages until the next successful send,
  // which for a weekly sender is days. The three COUNT gauges above are
  // zero-filled ("0 means 0"); a RATIO cannot be — a 0 would assert "we
  // dispatched and none failed". So the label is FORGOTTEN and the series
  // goes absent, which monitoring can express as "no data".
  for (const tenantId of observed) {
    if (!ratioTenants.has(tenantId)) {
      broadcastsMetrics.forgetDispatchFailureRate(tenantId);
    }
  }

  logger.info(
    {
      requestId,
      pendingTenantCount: pending.length,
      stuckTenantCount: stuck.length,
      dispatchRatioTenantCount: dispatchRatios.length,
      pendingTotal,
      stuckTotal,
      approvedOverdueTotal,
      batchNoProgressTotal,
      audienceImportStuckTotal,
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
      approvedOverdueTotal,
      batchNoProgressTotal,
      audienceImportStuckTotal,
      dispatchRatioMaxBps,
      stuckHours: STUCK_SENDING_HOURS,
      dispatchWindowHours: DISPATCH_FAILURE_WINDOW_HOURS,
    },
    { status: 200 },
  );
}
