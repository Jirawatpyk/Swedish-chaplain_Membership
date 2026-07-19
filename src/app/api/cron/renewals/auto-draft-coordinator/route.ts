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
import { sql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runInTenant } from '@/lib/db';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { renewalsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import { makeRenewalsDeps } from '@/modules/renewals';

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
 * The `MIN(created_at)` carries the SAME `FILTER` as the `COUNT`. Without
 * it the age would be measured from the oldest invoice of ANY origin/status
 * in the tenant — a number that looks perfectly plausible and is meaningless
 * (verified against the dev branch: filtered 7884965s vs unfiltered
 * 7885772s over the same rows). `COALESCE` handles the empty queue, where
 * `MIN` is NULL and the subtraction would otherwise observe NULL instead of
 * the correct 0.
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
 * definition `listCyclesEligibleForAutoDraft` already uses, so the detector
 * and the drafter agree on what "already billed" means. That also keeps the
 * population disjoint from Task 11's orphans: an orphan HAS a live issued
 * invoice, so `NOT EXISTS` excludes it and the two signals stay independent.
 */
async function observeAutoInvoiceGaugesForTenant(
  tenantId: string,
): Promise<void> {
  try {
    const ctx = asTenantContext(tenantId);
    type Row = {
      queue_size: number;
      oldest_age_seconds: number;
      awaiting_payment_no_invoice: number;
    };
    const rows = await runInTenant<ReadonlyArray<Row>>(ctx, async (tx) => {
      const result = await tx.execute(sql`
        SELECT
          -- (1) + (2) Review-queue depth and head-of-queue age.
          -- See the JSDoc above for why this predicate, why MIN carries the
          -- same FILTER, and why COALESCE is required.
          COUNT(*) FILTER (
            WHERE origin = 'auto_renewal' AND status = 'draft'
          )::int AS queue_size,
          COALESCE(
            EXTRACT(
              EPOCH FROM (
                NOW() - MIN(created_at) FILTER (
                  WHERE origin = 'auto_renewal' AND status = 'draft'
                )
              )
            ),
            0
          )::int AS oldest_age_seconds,
          -- (3) Wedged-state detector: cycles awaiting payment with no live
          -- membership invoice to pay. Steady-state expectation is 0.
          -- See the JSDoc above for the full rationale.
          (
            SELECT COUNT(*)::int
            FROM renewal_cycles rc
            WHERE rc.tenant_id = ${tenantId}
              AND rc.status = 'awaiting_payment'
              AND NOT EXISTS (
                SELECT 1
                FROM invoices live
                WHERE live.tenant_id = rc.tenant_id
                  AND live.member_id = rc.member_id
                  AND live.invoice_subject = 'membership'
                  AND live.status IN ('draft', 'issued')
              )
          ) AS awaiting_payment_no_invoice
        FROM invoices
        WHERE tenant_id = ${tenantId}
      `);
      // Drizzle's postgres-js driver returns the rows array directly.
      // Cast through `unknown` because the helper-level Row type is
      // narrower than the driver's untyped rowset.
      return (result as unknown as ReadonlyArray<Row>) ?? [];
    });
    const row = rows[0];
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
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId,
        gaugeKind: 'renewals_auto_invoice',
      },
      'cron.renewals.auto-draft.coordinator.gauge_observe_failed',
    );
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

  // Task 16 — feed the per-tenant auto-invoice gauges AFTER the fan-out so
  // they reflect the state this pass just produced. `allSettled` + the
  // helper's own try/catch mean a gauge failure can neither reject here nor
  // affect the summary below.
  await Promise.allSettled(
    activeTenants.map((tenantId) =>
      observeAutoInvoiceGaugesForTenant(tenantId),
    ),
  );

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
