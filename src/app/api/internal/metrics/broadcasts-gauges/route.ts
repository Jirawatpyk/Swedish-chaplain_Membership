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
 * F119 T121 — the broadcasts transaction also emits the four E-Blast
 * approval-stage gauges (`awaiting_member_approval_count`,
 * `awaiting_member_oldest_age_seconds`, `changes_requested_count`,
 * `marketing_turn_count`; `specs/119-eblast-approval-workflow/contracts/
 * dashboard-and-notifications.md` § 4.1), zero-filled like the counts.
 *
 * Idempotent: GET-only, read-only. Re-running emits identical samples.
 * Runtime: Node.js. Force-dynamic to skip Next cache.
 *
 * F114 T102 (research § V2) — this tick is ALSO the per-tenant gauges host
 * for the members module (`vercel.json` holds 37 of the Pro plan's 40 cron
 * jobs, so no module gets its own): a SECOND `db.transaction` after the
 * broadcasts one, with its own statement timeout and its own try/catch, emits
 * `members_change_requests_pending_count{tenant}` +
 * `members_change_request_oldest_age_seconds{tenant}`. A members-half
 * failure is logged (`cron.broadcasts_gauges.members_query_failed`) and
 * reported as `membersGaugesOk: false`; it never costs the broadcasts
 * samples. No `broadcasts_*` metric is renamed — the names live on the
 * `*Metrics` objects, not on this route.
 *
 * The independence is symmetric (PR-3 review, SEC-1): the BROADCASTS catch no
 * longer returns early either, so a broadcasts outage cannot take the FR-037
 * age gauge down with it. Its arrays stay empty (no sample is invented), the
 * members block runs, and the body carries an independent OK flag per half,
 * plus `membersGaugesSkipped: 'flag_off'` when the members half is
 * deliberately dark (SEC-5).
 *
 * The STATUS is the whole tick's verdict (PR-3 review B9): EITHER half failing
 * answers 500. A members-half fault used to answer 200 with the bad news only
 * in the body, so the one thing a cron monitor checks said the tick was fine
 * while the FR-037 age gauge was stale. Which half failed is still in the body
 * and the logs — that is what the alert rules key on (§ 27.3).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { broadcastsMetrics, membersMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
import { MARKETING_TURN_STATUSES } from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STUCK_SENDING_HOURS = 24;

/**
 * F119 T132 — the marketing-turn set as SQL bind values, derived from the
 * Domain (`turnOf(status) === 'marketing'`), so this gauge and the staff nav's
 * live waiting count (`drizzle-broadcast-approval-counter.ts`) count ONE set.
 * It was a hand-listed literal here.
 */
const MARKETING_TURN_IN = sql.join(
  MARKETING_TURN_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

interface TenantRow extends Record<string, unknown> {
  tenant_id: string;
}

interface PendingRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly count: number;
}

/** F114 — one row per tenant with ≥ 1 pending change request. */
interface MembersPendingRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly count: number;
  readonly oldest_age_seconds: number;
}

/**
 * F119 T121 — one row per tenant with ≥ 1 broadcast in an E-Blast approval
 * stage (`contracts/dashboard-and-notifications.md` § 4.1).
 */
interface EblastStageRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly awaiting_count: number;
  readonly awaiting_oldest_age_seconds: number;
  readonly changes_requested_count: number;
  readonly marketing_turn_count: number;
}

interface DispatchRatioRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly failed: number;
  readonly dispatched: number;
}

const DISPATCH_FAILURE_WINDOW_HOURS = 1;

/**
 * The members tenant set observed by the last SUCCESSFUL tick of this process
 * (PR-3 review B9).
 *
 * `observeGauge` re-reports a gauge's last value at every scrape, so a
 * members-half fault that emits nothing leaves both series FROZEN: a queue
 * that read "3 pending, oldest 13 d" keeps reading it, never crosses the 14 d
 * page threshold, and the outage looks like a quiet week. Forgetting the
 * labels is the honest answer (the SEC-5 flag-off path already does exactly
 * that) — but the set to forget is precisely what the failing query cannot
 * tell us, so the last one is remembered.
 *
 * PER PROCESS, deliberately: a fresh serverless instance has never emitted a
 * members gauge, so it has nothing to forget, and the next successful tick
 * re-observes the real set either way. It is a best-effort de-latch, not a
 * durable record.
 */
let lastMembersTenantSet: ReadonlySet<string> = new Set();

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

  // SEC-1 (PR-3 review): a broadcasts fault must NOT skip the members block.
  // This catch used to `return` the 500 straight out, so a broadcasts outage
  // silently took the FR-037 age gauge with it — the one alert that doubles as
  // the 30-day data-subject-request backstop, blind exactly when nobody is
  // looking. The halves are now independent BOTH ways: every array below
  // stays empty on a fault (so no broadcasts sample is invented), the members
  // block runs, and the 500 is answered at the END.
  let tenants: TenantRow[] = [];
  let pending: PendingRow[] = [];
  let stuck: PendingRow[] = [];
  let dispatchRatios: DispatchRatioRow[] = [];
  let suppressionSizes: PendingRow[] = [];
  let approvedOverdue: PendingRow[] = [];
  let audienceImportStuck: PendingRow[] = [];
  let eblastStages: EblastStageRow[] = [];
  let broadcastsGaugesOk = true;
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
      // T106 (108 US5, FR-044 f) — an audience IMPORT submitted but never
      // completed. `buildAudienceTick` turns such a row terminal, but only on a
      // tick that reaches it; this is the independent signal, and the one
      // number that says "Resend has stopped answering". 30 min matches
      // IMPORT_STUCK_AFTER_MS.
      //
      // `status = 'approved'` is load-bearing, added in review round 1 (S11 /
      // S46). Without it this gauge LATCHED: `failTerminally` resolves the
      // incident by moving the row to `failed_to_dispatch`, but it neither
      // clears `audience_import_id` nor stamps `completed_at`, and
      // `applyTransition`'s passthrough whitelist contains none of the three
      // import columns — so no writer anywhere in `src/` ever makes the row stop
      // matching. Every terminal refusal and every cancel-after-submit
      // incremented it permanently, and an alarm that never clears is worse than
      // no alarm because the next incident is invisible underneath it.
      //
      // Filtering on status is better than clearing the columns: it also
      // excludes a cancel-after-submit, and it leaves the forensic values in
      // place for whoever investigates.
      //
      // The `submitted_at IS NULL` shape that used to slip through here is now
      // impossible at the DB level — 0299 made the coherence CHECK an iff.
      const audienceImportStuckRows = await tx.execute<PendingRow>(sql`
        SELECT tenant_id, COUNT(*)::int AS count
        FROM broadcasts
        WHERE audience_import_id IS NOT NULL
          AND audience_import_completed_at IS NULL
          AND status::text = 'approved'
          AND audience_import_submitted_at < now() - interval '30 minutes'
        GROUP BY tenant_id
      `);
      // F119 T121 (§ 4.1) — the four E-Blast approval-stage gauges, one
      // grouped scan. The WHERE keeps the GROUP BY to tenants with a row in
      // one of the five stages; every other observed tenant is zero-filled
      // below. `status::text` like every sibling: a bare comparison against
      // a literal the pg enum does not (yet) carry is an error, not a miss.
      // MIN over zero FILTERed rows is NULL, hence the COALESCE. This query
      // needs migration 0305 (`stage_entered_at` + the five statuses), which
      // ships in the same PR and runs in `vercel-build` before the build.
      const eblastStageRows = await tx.execute<EblastStageRow>(sql`
        SELECT
          tenant_id,
          COUNT(*) FILTER (WHERE status::text = 'awaiting_member_approval')::int AS awaiting_count,
          COALESCE(
            EXTRACT(EPOCH FROM (now() - MIN(stage_entered_at) FILTER (WHERE status::text = 'awaiting_member_approval'))),
            0
          )::int AS awaiting_oldest_age_seconds,
          COUNT(*) FILTER (WHERE status::text = 'changes_requested')::int AS changes_requested_count,
          COUNT(*) FILTER (
            WHERE status::text IN (${MARKETING_TURN_IN})
          )::int AS marketing_turn_count
        FROM broadcasts
        WHERE status::text IN (${MARKETING_TURN_IN}, 'awaiting_member_approval')
        GROUP BY tenant_id
      `);
      const tenantRows = await tx.execute<TenantRow>(sql`
        SELECT DISTINCT tenant_id FROM broadcasts
      `);
      return {
        tenantRows,
        pendingRows,
        stuckRows,
        dispatchRows,
        suppressionRows,
        approvedOverdueRows,
        audienceImportStuckRows,
        eblastStageRows,
      };
    });
    tenants = Array.from(result.tenantRows ?? []);
    pending = Array.from(result.pendingRows);
    stuck = Array.from(result.stuckRows);
    dispatchRatios = Array.from(result.dispatchRows);
    suppressionSizes = Array.from(result.suppressionRows);
    approvedOverdue = Array.from(result.approvedOverdueRows);
    audienceImportStuck = Array.from(result.audienceImportStuckRows ?? []);
    eblastStages = Array.from(result.eblastStageRows ?? []);
  } catch (e) {
    broadcastsGaugesOk = false;
    logger.error(
      { requestId, err: errKind(e) },
      'cron.broadcasts_gauges.query_failed',
    );
  }

  let pendingTotal = 0;
  let stuckTotal = 0;
  let dispatchRatioMaxBps = 0; // basis points — 0..10000
  // C9: zero-fill — a tenant absent from a GROUP BY is at 0, and 0 is
  // observed, so a resolved incident clears the gauge on the next tick.
  const pendingByTenant = new Map(pending.map((r) => [r.tenant_id, r.count]));
  const stuckByTenant = new Map(stuck.map((r) => [r.tenant_id, r.count]));
  const overdueByTenant = new Map(approvedOverdue.map((r) => [r.tenant_id, r.count]));
  const importStuckByTenant = new Map(audienceImportStuck.map((r) => [r.tenant_id, r.count]));
  const suppressionByTenant = new Map(suppressionSizes.map((r) => [r.tenant_id, r.count]));
  const eblastStageByTenant = new Map(eblastStages.map((r) => [r.tenant_id, r]));
  const observed = new Set<string>();
  for (const t of [
    ...tenants.map((r) => r.tenant_id),
    ...pendingByTenant.keys(),
    ...stuckByTenant.keys(),
    ...overdueByTenant.keys(),
    ...importStuckByTenant.keys(),
    // A tenant can carry unsubscribes with no `broadcasts` row at all (a
    // contact-level opt-out recorded before the first send), so the
    // suppression keys join the observed set rather than relying on it.
    ...suppressionByTenant.keys(),
    ...eblastStageByTenant.keys(),
  ]) {
    observed.add(t);
  }
  let approvedOverdueTotal = 0;
  let audienceImportStuckTotal = 0;
  for (const tenantId of observed) {
    const p = pendingByTenant.get(tenantId) ?? 0;
    const s = stuckByTenant.get(tenantId) ?? 0;
    const o = overdueByTenant.get(tenantId) ?? 0;
    broadcastsMetrics.queuePending(tenantId, p);
    broadcastsMetrics.stuckSendingCount(tenantId, s);
    broadcastsMetrics.approvedOverdueCount(tenantId, o);
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
  // F119 T121 (§ 4.1) — all four are ZERO-FILLED, not forgotten: three are
  // counts, and the oldest age is a level where 0 means "nothing waiting"
  // (the same choice as the F114 members age gauge below). Only a ratio is
  // forgotten, because its 0 would assert something that did not happen.
  // The age is clamped: it can only be negative under DB/app clock skew,
  // and the § 4.3 alert rules must never see a nonsense value.
  for (const tenantId of observed) {
    const row = eblastStageByTenant.get(tenantId);
    broadcastsMetrics.awaitingMemberApprovalCount(tenantId, row?.awaiting_count ?? 0);
    broadcastsMetrics.awaitingMemberOldestAgeSeconds(tenantId, Math.max(0, row?.awaiting_oldest_age_seconds ?? 0));
    broadcastsMetrics.changesRequestedCount(tenantId, row?.changes_requested_count ?? 0);
    broadcastsMetrics.marketingTurnCount(tenantId, row?.marketing_turn_count ?? 0);
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

  // -------------------------------------------------------------------------
  // F114 T102 (research R12 + § V2) — the members change-request gauges.
  //
  // A SECOND transaction, on the same pool-global `db` every gauge above
  // uses deliberately (owner role, BYPASSRLS: these are cross-tenant
  // `GROUP BY tenant_id` reads for internal metrics, never a tenant-scoped
  // path), with its own statement timeout and its own try/catch: a fault in
  // `member_change_requests` must not cost the six broadcasts samples just
  // emitted, and the broadcasts 500 above must not hide a members fault.
  //
  // C9 latch rule, again: `observeGauge` re-reports the last value at every
  // scrape, so a tenant whose queue drained emits no GROUP BY row and would
  // keep reading its old count forever — and FR-037's "> 14 d" page would
  // never clear. Every PROVISIONED tenant is observed; 0 pending is reported
  // as 0 on both gauges ("0 means 0" — the metric convention; the read
  // model's `null` age is a UI one).
  //
  // A4 (PR-3 review) — the zero-fill tenant set was `SELECT DISTINCT tenant_id
  // FROM member_change_requests`: an index-only scan of the WHOLE request
  // history, every 5 min, whose cost grows with RETENTION rather than with the
  // number of tenants. It is now `tenant_member_settings` (one row per
  // provisioned tenant) ∪ the pending GROUP BY keys — the union is what keeps
  // a tenant with pending rows but no settings row (a pre-0209 seed) observed.
  //
  // SEC-5 (PR-3 review) — while `FEATURE_MEMBER_CHANGE_APPROVAL` is OFF the
  // queue routes 404 and nobody can decide a retained request, so the pending
  // scan is skipped and both series are FORGOTTEN per tenant (absence, not a
  // fabricated 0: a 0 would assert "the queue is empty", a different fact) so
  // no value can latch across a flag flip. The tiny provisioned-tenant read
  // still runs — forgetting a label set requires knowing it.
  // -------------------------------------------------------------------------
  const membersGaugesSkipped: 'flag_off' | null = env.features.memberChangeApproval ? null : 'flag_off';
  const membersPendingByTenant = new Map<string, MembersPendingRow>();
  const membersObserved = new Set<string>();
  let membersGaugesOk = true;
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
      const tenantRows = await tx.execute<TenantRow>(sql`
        SELECT tenant_id FROM tenant_member_settings
      `);
      if (membersGaugesSkipped !== null) return { tenantRows, pendingRows: [] as MembersPendingRow[] };
      const pendingRows = await tx.execute<MembersPendingRow>(sql`
        SELECT
          tenant_id,
          COUNT(*)::int AS count,
          EXTRACT(EPOCH FROM (now() - MIN(submitted_at)))::int AS oldest_age_seconds
        FROM member_change_requests
        WHERE state::text = 'pending'
        GROUP BY tenant_id
      `);
      return { tenantRows, pendingRows };
    });
    for (const row of Array.from(result.tenantRows ?? [])) membersObserved.add(row.tenant_id);
    for (const row of Array.from(result.pendingRows ?? [])) {
      membersPendingByTenant.set(row.tenant_id, row);
      membersObserved.add(row.tenant_id);
    }
    lastMembersTenantSet = new Set(membersObserved);
  } catch (e) {
    membersGaugesOk = false;
    logger.error({ requestId, err: errKind(e) }, 'cron.broadcasts_gauges.members_query_failed');
    // B9: de-latch. Nothing was read, so nothing can be stated — and leaving
    // the last values in place turns a sustained outage into a frozen queue
    // depth and a frozen age that never reaches the 14 d page.
    for (const tenantId of lastMembersTenantSet) {
      membersMetrics.changeRequests.forgetGauges(tenantId);
    }
  }
  let membersPendingTotal = 0;
  let membersOldestAgeSecondsMax = 0;
  for (const tenantId of membersObserved) {
    if (membersGaugesSkipped !== null) {
      membersMetrics.changeRequests.forgetGauges(tenantId);
      continue;
    }
    const row = membersPendingByTenant.get(tenantId);
    const count = row?.count ?? 0;
    // an age can only be negative under clock skew between the DB and a row
    // stamped by the app; clamp so the alert rule never sees a nonsense value
    const age = Math.max(0, row?.oldest_age_seconds ?? 0);
    membersMetrics.changeRequests.pendingCount(tenantId, count);
    membersMetrics.changeRequests.oldestAgeSeconds(tenantId, age);
    membersPendingTotal += count;
    if (age > membersOldestAgeSecondsMax) membersOldestAgeSecondsMax = age;
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
      audienceImportStuckTotal,
      dispatchRatioMaxBps,
      stuckHours: STUCK_SENDING_HOURS,
      dispatchWindowHours: DISPATCH_FAILURE_WINDOW_HOURS,
      broadcastsGaugesOk,
      membersGaugesOk,
      membersGaugesSkipped,
      membersPendingTenantCount: membersPendingByTenant.size,
      membersPendingTotal,
      membersOldestAgeSecondsMax,
    },
    'cron.broadcasts_gauges.completed',
  );

  // B9: EITHER half failing is a failed tick. The per-half flags below say
  // WHICH, and the two log names are unchanged, so the existing alert rules
  // keep working (§ 27.3).
  const tickOk = broadcastsGaugesOk && membersGaugesOk;
  return NextResponse.json(
    {
      // SEC-1 + B9: answered HERE, after BOTH halves have run, keeping the
      // body and log names the alerting already keys on.
      ok: tickOk,
      ...(tickOk ? {} : { error: 'query_failed' }),
      broadcastsGaugesOk,
      pendingTenantCount: pending.length,
      stuckTenantCount: stuck.length,
      dispatchRatioTenantCount: dispatchRatios.length,
      pendingTotal,
      stuckTotal,
      approvedOverdueTotal,
      audienceImportStuckTotal,
      dispatchRatioMaxBps,
      stuckHours: STUCK_SENDING_HOURS,
      dispatchWindowHours: DISPATCH_FAILURE_WINDOW_HOURS,
      membersGaugesOk,
      membersGaugesSkipped,
      membersPendingTenantCount: membersPendingByTenant.size,
      membersPendingTotal,
      membersOldestAgeSecondsMax,
    },
    { status: tickOk ? 200 : 500 },
  );
}
