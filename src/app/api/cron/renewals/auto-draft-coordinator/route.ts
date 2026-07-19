/**
 * 107-auto-invoice Task 8 — Daily auto-draft cron coordinator.
 *
 * Triggered DAILY (05:00 ICT, before the 06:00 ICT dispatch chain —
 * see `vercel.json`) by Vercel-native cron. Fans out via internal HTTP
 * to `auto-draft/[tenantId]` for own-budget isolation, mirroring every
 * other F8 coordinator (`enter-awaiting-payment-coordinator` template).
 *
 * Sequenced BEFORE the reminder-dispatch chain: a member's fresh
 * `origin='auto_renewal'` DRAFT invoice should exist before the day's
 * reminder pass runs, so a treasurer working the review queue is never
 * racing the dispatcher. (The two cron chains are otherwise
 * independent — auto-draft creates a draft invoice, dispatch sends
 * reminder emails; neither depends on the other's OUTPUT, only the
 * ordering avoids a same-day treasurer/dispatch surprise.)
 *
 * Auth: Bearer via `CRON_SECRET` env var (constant-time check).
 *
 * Three-key dark-ship (design §5.7) — env layer: BOTH
 * `FEATURE_F8_RENEWALS` and `FEATURE_AUTO_INVOICE` must be `true`, else
 * `200 {skipped: true}` (never 503 — Vercel/cron must not retry-storm).
 * Key #3 (`tenant_invoice_settings.auto_invoice_enabled` + cadence) is
 * enforced per-tenant inside the worker's use-case call (Task 7).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { renewalsMetrics } from '@/lib/metrics';
import { makeRenewalsDeps, readAutoInvoiceGaugeRow } from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 107-auto-invoice Task 16 — observable-gauge feed.
 *
 * Emits the three per-tenant auto-invoice gauges once per coordinator pass
 * (daily — sufficient cadence for backlog/SLO panels, matching the
 * `observeCycleStateGaugesForTenant` precedent in the dispatch
 * coordinator, which this function mirrors structurally).
 *
 * Runs AFTER the fan-out so the numbers reflect the state the cron just
 * produced rather than yesterday's.
 *
 * Best-effort by contract: the whole body is wrapped in try/catch and every
 * `renewalsMetrics.*` call is itself `safeMetric`-wrapped. A gauge that
 * takes the cron down is worse than no gauge — a count-query glitch must
 * never fail or delay a pass. Failures are logged at `warn` (not `error`:
 * losing a day of gauge resolution is not an actionable page) so sustained
 * failure is still detectable.
 *
 * Tenant isolation: the aggregate runs on the `tx` threaded from
 * `runInTenant` (which sets `app.current_tenant`, so RLS+FORCE applies) AND
 * carries an explicit `tenant_id = ${tenantId}` predicate on every table it
 * touches — Constitution Principle I two-layer isolation, matching the
 * Task 6/7/9 cross-module queries in `drizzle-renewal-cycle-repo.ts`.
 *
 * ---
 * **Query notes** (kept here rather than as `--` comments inside the
 * template: a backtick inside a tagged template literal terminates it, and
 * these names all want backticks).
 *
 * *(1) + (2) queue depth and head-of-queue age.* `origin='auto_renewal' AND
 * status='draft'` is the treasurer's review queue verbatim — the same
 * predicate `load-auto-renewal-queue-context.ts` selects on. Keep the two in
 * sync: a gauge that disagrees with the screen the operator is looking at is
 * worse than no gauge. No `invoice_subject` filter, deliberately, for the
 * same reason — the queue does not carry one either (only the membership
 * auto-draft path ever writes `origin='auto_renewal'`, so the two are
 * equivalent today, and matching the screen matters more than defensive
 * narrowing).
 *
 * Both are written as scalar subqueries with the predicate in `WHERE`, NOT
 * as `COUNT(*) FILTER (...)` over an outer `FROM invoices` (review MAJOR-2).
 * A `FILTER` clause is never index-eligible: the planner must read every
 * tenant row and discard non-matching ones. Measured on the dev branch
 * before the change — `Seq Scan on invoices, rows=50, Rows Removed by
 * Filter: 389, Execution Time: 11.7 ms` — for a query whose answer is
 * almost always 0. With the predicate in `WHERE`, the partial index
 * `invoices_auto_renewal_draft_idx (tenant_id, created_at) WHERE
 * origin='auto_renewal' AND status='draft'` (migration 0264) serves both,
 * and `MIN(created_at)` becomes an index-ordered first-row read.
 *
 * The restructure also removes a whole BUG CLASS. The previous shape needed
 * the same `FILTER` repeated on both the `COUNT` and the `MIN`, and omitting
 * it on the `MIN` silently measured age from the oldest invoice of ANY
 * origin/status — a number that looks perfectly plausible and is meaningless
 * (verified: filtered 7884965s vs unfiltered 7885772s over identical rows).
 * With each aggregate in its own subquery, its predicate sits in a `WHERE`
 * that cannot be forgotten without the query failing to mean anything at
 * all. `COALESCE` still covers the empty queue, where `MIN` is NULL.
 *
 * *(3) wedged-state detector.* A non-zero value means a member is suspended
 * pending payment of a bill that does not exist — never billed, never
 * chased, and invisible on every other panel (`membership_suspended_count`
 * counts them as ordinary unpaid, which raises no suspicion). Task 9
 * documented the non-recovery window that produces this (mutual abort near
 * the T-0 boundary); Task 11's reconcile repairs the INVERSE defect (issued
 * invoice, missing cycle link) and cannot see this one.
 *
 * "Live invoice" is member-level (`invoice_subject='membership' AND status
 * IN ('draft','issued')`) — the exact `noLiveMembershipInvoiceSql`
 * definition `listCyclesEligibleForAutoDraft` already uses. This is not just
 * drift-avoidance, it is semantic: the drafter uses the member-level rule to
 * decide who to bill, so a plan-year-precise detector would flag members the
 * drafter is *deliberately declining* to draft for and report a wedge the
 * system is behaving correctly about. It also keeps the population disjoint
 * from Task 11's orphans: an orphan HAS a live issued invoice, so
 * `NOT EXISTS` excludes it and the two signals stay independent.
 *
 * **The member-side gate is load-bearing (review BLOCKER-1).** The original
 * version copied `noLiveMembershipInvoiceSql` but not the member gate that
 * sits beside it in the same repo function, so the detector and the drafter
 * agreed on *invoice liveness* but not on *who is billable* — and AI-A1's
 * "steady state is 0" was simply false. Four routine paths landed in the
 * population: (a) an invoice voided for correction (nothing clears
 * `linked_invoice_id` on void, and void-on-reissue is now a treasurer's
 * routine action); (b) an archive-cascade failure (`archive-member.ts` runs
 * it post-commit and non-fatal); (c) the erasure window (`scrubPiiInTx`
 * leaves `status`/`archived_at` alone by design); and (d)
 * `listCyclesEligibleForAwaitingPayment`, which has no member gate at all
 * and so flips archived members' cycles to `awaiting_payment`. Gating on
 * `archived_at IS NULL AND status <> 'archived' AND erased_at IS NULL`
 * removes (b), (c) and (d).
 *
 * Case (a) — void — is deliberately KEPT in the population: a member whose
 * invoice was voided for correction genuinely IS awaiting a bill, so
 * excluding void would blind the gauge to a real wedge. What is wrong is
 * alerting on it *instantaneously*, since that state is expected to be
 * brief. Hence AI-A1 ships report-only, and when promoted must fire on
 * SUSTAINED wedge (age-based), never on `> 0`. See `docs/observability.md`
 * § 26.3 and `docs/runbooks/auto-invoice-wedged-cycles.md`.
 *
 * Enrolment (`auto_invoice_enrolled_at`) is deliberately NOT part of the
 * gate even though the drafter checks it. Enrolment decides WHO repairs a
 * wedge (cron vs treasurer), not whether the state is broken — a
 * non-enrolled member sitting in `awaiting_payment` with no invoice is
 * exactly as wedged, and gating on enrolment would hide them.
 */
/**
 * Hard ceiling on the gauge feed, in ms (review MAJOR-1).
 *
 * `try`/`catch` guards a THROW, not a HANG. A gauge query wedged on a lock
 * or a stalled Neon connection would otherwise sit here burning the
 * coordinator's remaining Vercel function budget with nothing to show for
 * it. 5 s is ~400x the measured cost of the (pre-index) aggregate, so it can
 * only fire on a genuine stall, never on ordinary slowness.
 *
 * The losing promise is abandoned, not cancelled — Postgres will finish or
 * error on its own and the result is discarded. That is acceptable precisely
 * because this path has no side effects beyond writing a gauge value.
 */
const GAUGE_FEED_TIMEOUT_MS = 5_000;

async function observeAutoInvoiceGaugesForTenant(
  tenantId: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // SQL lives in `@/modules/renewals` (auto-invoice-gauge-query.ts) rather
    // than inline here, so it can be pinned by an integration test against
    // live Neon — review MAJOR-3. A Next.js route cannot export arbitrary
    // symbols for a test to import, and the coordinator unit test mocks
    // `runInTenant`, so inline the query was covered by nothing.
    const query = readAutoInvoiceGaugeRow(tenantId);

    const row = await Promise.race([
      query,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `gauge feed exceeded ${GAUGE_FEED_TIMEOUT_MS}ms — abandoned`,
              ),
            ),
          GAUGE_FEED_TIMEOUT_MS,
        );
      }),
    ]);

    if (!row) return;
    renewalsMetrics.observeAutoDraftQueueSizeGauge(tenantId, row.queue_size);
    renewalsMetrics.observeAutoDraftOldestAgeGauge(
      tenantId,
      row.oldest_age_seconds,
    );
    renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(
      tenantId,
      row.awaiting_payment_no_invoice,
    );
  } catch (e) {
    // Review MAJOR-4 — drop this tenant's last-observed values rather than
    // leaving them frozen. Without this, a permanently-failing query keeps
    // re-reporting the last successful number at every scrape: a stale `> 0`
    // alerts forever on an already-repaired wedge, and a stale `0` masks a
    // real one — destroying the "0 means 0" property AI-A1 rests on. An
    // ABSENT series is a condition monitoring can express ("alert on no
    // data"); a stale number is a lie. See the method's docstring.
    renewalsMetrics.forgetAutoInvoiceGauges(tenantId);
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId,
        gaugeKind: 'renewals_auto_invoice',
      },
      'cron.renewals.auto-draft.coordinator.gauge_observe_failed',
    );
  } finally {
    // Release the timeout handle on every path, including the happy one —
    // a pending timer would otherwise keep the event loop (and the Vercel
    // function) alive for up to 5s after the work is done.
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface PerTenantResult {
  readonly tenant_id: string;
  readonly skipped?: boolean;
  readonly cycles_processed?: number;
  readonly drafted?: number;
  readonly skipped_existing?: number;
  readonly skipped_race_lost?: number;
  readonly skipped_terminated?: number;
  readonly errors?: number;
  readonly duration_ms?: number;
  readonly error?: string;
}

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and any manual/legacy POST trigger.
// POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Shared bearer-auth gate emits the `cron_bearer_auth_rejected` audit
  // + IP rate-limit on rejection (uniform across all F8 cron coords).
  const authResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/auto-draft-coordinator',
    metricsCounter: () => renewalsMetrics.coordinatorAuditEmitFailed('auto_draft'),
    // Upstash fail-open counter — parity with the other coordinators.
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (authResponse) return authResponse;

  if (!env.features.f8Renewals || !env.features.autoInvoice) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }
  // READ_ONLY_MODE short-circuit (200 + skipped, no audit) so
  // cron-job.org / Vercel cron does not retry-storm during maintenance.
  // See lapse-coordinator for the full rationale.
  if (env.flags.readOnlyMode) {
    renewalsMetrics.coordinatorSkippedReadOnly('auto_draft');
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();

  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_auto_draft_coordinator',
    { 'cron.endpoint': 'auto-draft-coordinator' },
    async (span) => {
  const startedAt = Date.now();

  // Resolve active tenants (MVP single-tenant = [env.tenant.slug]).
  const activeTenants: ReadonlyArray<string> = [env.tenant.slug];
  span.setAttribute('renewals.tenants_enqueued', activeTenants.length);

  if (activeTenants.length === 0) {
    const summary = {
      tenants_enqueued: 0,
      tenants_succeeded: 0,
      tenants_failed: 0,
      duration_ms: Date.now() - startedAt,
    };
    try {
      const deps = makeRenewalsDeps(env.tenant.slug);
      await deps.auditEmitter.emit(
        {
          type: 'cron_dispatch_orchestrated',
          payload: {
            cron_kind: 'auto_draft',
            ...summary,
            tenants_skipped_kill_switch: 0,
            per_tenant_summaries: [],
          },
        },
        {
          tenantId: env.tenant.slug,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId: correlationId,
        },
      );
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e : new Error(String(e)), correlationId },
        'cron.renewals.auto-draft.coordinator.audit_emit_failed',
      );
      renewalsMetrics.coordinatorAuditEmitFailed('auto_draft');
    }
    renewalsMetrics.coordinatorTenantsEnqueued('auto_draft', 0);
    renewalsMetrics.coordinatorTenantsSucceeded('auto_draft', 0);
    renewalsMetrics.coordinatorDurationMs('auto_draft', summary.duration_ms);
    return NextResponse.json({ ...summary, per_tenant_results: [] });
  }

  const baseUrl = env.app.baseUrl;
  const cronSecret = env.cron.secret;

  const numFromJson = (
    json: Record<string, unknown>,
    key: string,
  ): number => (typeof json[key] === 'number' ? (json[key] as number) : 0);

  const settled = await Promise.allSettled(
    activeTenants.map((tenantId) =>
      (async (): Promise<PerTenantResult> => {
        const r = await fetch(
          `${baseUrl}/api/cron/renewals/auto-draft/${encodeURIComponent(tenantId)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cronSecret}`,
              'x-request-id': correlationId,
            },
          },
        );
        let json: Record<string, unknown> = {};
        try {
          json = (await r.json()) as Record<string, unknown>;
        } catch {
          return {
            tenant_id: tenantId,
            error: `http_${r.status}_json_parse_failed`,
          };
        }
        if (!r.ok) {
          return { tenant_id: tenantId, error: `http_${r.status}` };
        }
        return {
          tenant_id: tenantId,
          skipped: Boolean(json.skipped),
          cycles_processed: numFromJson(json, 'cycles_processed'),
          drafted: numFromJson(json, 'drafted'),
          skipped_existing: numFromJson(json, 'skipped_existing'),
          skipped_race_lost: numFromJson(json, 'skipped_race_lost'),
          skipped_terminated: numFromJson(json, 'skipped_terminated'),
          errors: numFromJson(json, 'errors'),
          duration_ms: numFromJson(json, 'duration_ms'),
        };
      })(),
    ),
  );

  const perTenantResults: PerTenantResult[] = settled.map((r, i) => {
    const tenantId = activeTenants[i]!;
    if (r.status === 'rejected') {
      // Do NOT persist `String(r.reason)` into audit_log — it leaks DB
      // connection strings, column names, internal stack frames into
      // immutable audit rows. Use a fixed taxonomy.
      logger.error(
        {
          err: r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
          tenant_id: tenantId,
          correlationId,
        },
        'cron.renewals.auto-draft.coordinator.per_tenant_fetch_rejected',
      );
      return { tenant_id: tenantId, error: 'fetch_rejected' };
    }
    return r.value;
  });

  const tenantsSucceeded = perTenantResults.filter(
    (r) => r.error === undefined,
  ).length;
  const tenantsFailed = perTenantResults.length - tenantsSucceeded;
  // Surface tenants that returned 200-OK but had per-cycle errors so a
  // tenant whose transition consistently throws does not appear "100%
  // healthy" while no cycles actually drafted.
  const tenantsWithErrors = perTenantResults.filter(
    (r) => r.error === undefined && (r.errors ?? 0) > 0,
  ).length;

  const summary = {
    tenants_enqueued: activeTenants.length,
    tenants_succeeded: tenantsSucceeded,
    tenants_failed: tenantsFailed,
    tenants_skipped_kill_switch: 0,
    duration_ms: Date.now() - startedAt,
  };

  span.setAttribute('renewals.tenants_succeeded', tenantsSucceeded);
  span.setAttribute('renewals.tenants_failed', tenantsFailed);
  span.setAttribute('renewals.duration_ms', summary.duration_ms);

  try {
    const deps = makeRenewalsDeps(env.tenant.slug);
    await deps.auditEmitter.emit(
      {
        type: 'cron_dispatch_orchestrated',
        payload: {
          cron_kind: 'auto_draft',
          ...summary,
          per_tenant_summaries: perTenantResults.map((r) =>
            r.error !== undefined
              ? { tenant_id: r.tenant_id, error: r.error }
              : {
                  tenant_id: r.tenant_id,
                  skipped: r.skipped ?? false,
                  // This cron creates no reminder tasks — repurpose the
                  // legacy slot to carry the cycles-processed count
                  // (matches the `enter_awaiting` coordinator's
                  // precedent); the real counters live in `kind_specific`.
                  reminders_dispatched: r.cycles_processed ?? 0,
                  tasks_created: 0,
                  duration_ms: r.duration_ms ?? 0,
                  kind_specific: {
                    kind: 'auto_draft',
                    errors: r.errors ?? 0,
                    drafted: r.drafted ?? 0,
                    // The `auto_draft` kind_specific shape carries one
                    // aggregate `skipped` counter (no per-reason
                    // breakdown) — sum the use-case's 3 named skip
                    // buckets.
                    skipped:
                      (r.skipped_existing ?? 0) +
                      (r.skipped_race_lost ?? 0) +
                      (r.skipped_terminated ?? 0),
                  },
                },
          ),
        },
      },
      {
        tenantId: env.tenant.slug,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
        requestId: correlationId,
      },
    );
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e : new Error(String(e)), correlationId },
      'cron.renewals.auto-draft.coordinator.audit_emit_failed',
    );
    renewalsMetrics.coordinatorAuditEmitFailed('auto_draft');
  }

  renewalsMetrics.coordinatorTenantsEnqueued('auto_draft', summary.tenants_enqueued);
  renewalsMetrics.coordinatorTenantsSucceeded('auto_draft', summary.tenants_succeeded);
  if (summary.tenants_failed > 0) {
    renewalsMetrics.coordinatorTenantsFailed('auto_draft', summary.tenants_failed);
  }
  renewalsMetrics.coordinatorDurationMs('auto_draft', summary.duration_ms);

  // Task 16 — feed the per-tenant auto-invoice gauges.
  //
  // Placement is deliberate (review MAJOR-1): AFTER the fan-out, so the
  // numbers reflect the state this pass just produced, but also after the
  // durable audit row AND after `coordinatorDurationMs`. An earlier revision
  // ran this before `summary.duration_ms` was computed, which folded gauge
  // latency into both the audit row and `renewals.coordinator.duration_ms` —
  // the very metric docs/observability.md § 26.4 names as the stand-in for
  // the not-yet-recorded p95 SLO. Measuring the observer inside the
  // measurement is exactly backwards. The dispatch coordinator already gets
  // this right (duration first, then gauges); this now matches it.
  await Promise.allSettled(
    activeTenants.map((tenantId) =>
      observeAutoInvoiceGaugesForTenant(tenantId),
    ),
  );

  logger.info(
    {
      correlationId,
      ...summary,
      tenants_with_errors: tenantsWithErrors,
    },
    'cron.renewals.auto-draft.coordinator.complete',
  );

  return NextResponse.json({
    ...summary,
    tenants_with_errors: tenantsWithErrors,
    per_tenant_results: perTenantResults,
  });
  }); // end withActiveSpan
}
