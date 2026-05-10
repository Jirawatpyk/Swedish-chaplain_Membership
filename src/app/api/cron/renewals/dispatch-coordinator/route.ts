/**
 * F8 Phase 4 Wave I5 / T103 — Daily reminder dispatch coordinator.
 *
 * Triggered DAILY at 06:00 Asia/Bangkok by cron-job.org per
 * `docs/runbooks/cron-jobs.md` F8 entry. Resolves the set of active
 * tenants, fans out to per-tenant `/api/cron/renewals/dispatch/[tenantId]`
 * routes via internal HTTP, aggregates results, emits
 * `cron_dispatch_orchestrated` audit, returns a summary.
 *
 * Architecture (per `contracts/cron-renewals-api.md` + research.md R14):
 *   - coordinator + per-tenant fan-out keeps each per-tenant
 *     invocation in its OWN Vercel function instance with its own
 *     300s budget. Per-tenant SLO < 60s @ 5k members per FR-017
 *     fits comfortably under one function timeout.
 *   - Promise.allSettled isolates per-tenant failures — a single
 *     tenant's error doesn't block others.
 *   - FR-011 idempotency on the dispatch use-case means retries on
 *     the next cron pass are safe (no duplicate sends).
 *
 * MVP single-tenant: "active tenants" = `[env.tenant.slug]`. Post-F10
 * SaaS multi-tenant would query a real tenants table.
 *
 * Auth: Bearer via `CRON_SECRET` env var (constant-time check via
 * shared `verifyCronBearer` helper). Mismatched/missing → 401.
 *
 * Kill-switch: `FEATURE_F8_RENEWALS=false` returns 200 +
 * `{skipped: true, reason: 'feature_flag_disabled'}` so cron-job.org
 * does NOT retry-storm a dark-launch period.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { db, runInTenant } from '@/lib/db';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { renewalsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import { makeRenewalsDeps } from '@/modules/renewals';

/**
 * Phase 9 / T231 + Cycle-state observable gauge wiring.
 *
 * Aggregates `renewal_cycles` row counts by state per tenant and
 * emits to the `renewalsMetrics.observeCycleStateGauge` map. Runs
 * inside the daily dispatch coordinator (once per day per tenant —
 * sufficient cadence for SLO panels). Failure swallowed via try/
 * catch — gauge observation must NEVER block the cron pass.
 *
 * Cardinality bound: 3 states × small tenant count.
 */
async function observeCycleStateGaugesForTenant(
  tenantId: string,
): Promise<void> {
  try {
    const ctx = asTenantContext(tenantId);
    type Row = { active: number; in_grace: number; lapsed_total: number };
    const rows = await runInTenant<ReadonlyArray<Row>>(ctx, async (tx) => {
      const result = await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE status IN ('upcoming','reminded','awaiting_payment','pending_admin_reactivation')
          )::int AS active,
          COUNT(*) FILTER (
            WHERE status = 'awaiting_payment' AND expires_at < NOW()
          )::int AS in_grace,
          COUNT(*) FILTER (WHERE status = 'lapsed')::int AS lapsed_total
        FROM renewal_cycles
      `);
      // Drizzle's postgres-js driver returns the rows array directly.
      // Cast through `unknown` because the helper-level Row type is
      // narrower than the driver's untyped rowset.
      return (result as unknown as ReadonlyArray<Row>) ?? [];
    });
    const row = rows[0];
    if (!row) return;
    renewalsMetrics.observeCycleStateGauge(tenantId, 'active', row.active);
    renewalsMetrics.observeCycleStateGauge(
      tenantId,
      'in_grace',
      row.in_grace,
    );
    renewalsMetrics.observeCycleStateGauge(
      tenantId,
      'lapsed_total',
      row.lapsed_total,
    );
  } catch (e) {
    // Gauge observation is best-effort — never block coordinator on
    // a count-query glitch. Log loudly so ops can detect sustained
    // failure (which would indicate broken aggregation queries).
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId,
        gaugeKind: 'renewals_cycles_state',
      },
      'cron.renewals.coordinator.gauge_observe_failed',
    );
  }
}

// K12-6 (SEC-K-5) rate-limit + Upstash fail-open + audit emit on the
// 401 path now lives in `gateCronBearerOrRespond` (`src/lib/cron-auth.ts`).
// 60 req/60s/IP cap, generous for CRON_SECRET rotation scenarios while
// bounding audit-write burst — see helper docstring for the full
// rationale.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PerTenantResultOk {
  readonly tenant_id: string;
  readonly skipped: boolean;
  readonly reminders_dispatched?: number;
  readonly tasks_created?: number;
  readonly duration_ms?: number;
}

interface PerTenantResultErr {
  readonly tenant_id: string;
  readonly error: string;
}

type PerTenantResult = PerTenantResultOk | PerTenantResultErr;

interface OrchestratedSummary {
  readonly tenants_enqueued: number;
  readonly tenants_succeeded: number;
  readonly tenants_failed: number;
  // K5: tenants where the per-tenant route short-circuited via
  // kill-switch (feature_flag_disabled) or read-only-mode. Counted
  // separately from succeeded so ops dashboards distinguish "no work
  // because feature off" from "no work because nothing was due".
  // Without this, a dark-launched tenant flag-flapping silently
  // appears as "100% healthy" while no dispatches ran.
  readonly tenants_skipped_kill_switch: number;
  readonly duration_ms: number;
}

/**
 * Emit the `cron_dispatch_orchestrated` audit on the bookkeeping
 * tenant (env.tenant.slug). Wrapped in try/catch + WARN log — audit
 * emit failure must NOT break the coordinator response.
 */
async function emitOrchestratedAudit(
  bookkeepingTenantSlug: string,
  summary: OrchestratedSummary,
  perTenantResults: ReadonlyArray<PerTenantResult>,
  correlationId: string,
): Promise<void> {
  try {
    const deps = makeRenewalsDeps(bookkeepingTenantSlug);
    await deps.auditEmitter.emit(
      {
        type: 'cron_dispatch_orchestrated',
        payload: {
          cron_kind: 'dispatch',
          tenants_enqueued: summary.tenants_enqueued,
          tenants_succeeded: summary.tenants_succeeded,
          tenants_failed: summary.tenants_failed,
          tenants_skipped_kill_switch: summary.tenants_skipped_kill_switch,
          duration_ms: summary.duration_ms,
          // bounded-cardinality summary — no PII in the per-tenant payload.
          per_tenant_summaries: perTenantResults.map((r) =>
            'error' in r
              ? { tenant_id: r.tenant_id, error: r.error }
              : {
                  tenant_id: r.tenant_id,
                  skipped: r.skipped,
                  reminders_dispatched: r.reminders_dispatched ?? 0,
                  // Round-5 review-finding M3: dispatch coord owns the
                  // literal "tasks_created" semantics (escalation tasks
                  // created during the daily ladder). Other coordinators
                  // set this to 0 and surface their counters via
                  // `kind_specific`. Mirror the value in `kind_specific`
                  // so dashboards can choose a uniform read path.
                  tasks_created: r.tasks_created ?? 0,
                  duration_ms: r.duration_ms ?? 0,
                  kind_specific: {
                    kind: 'dispatch',
                    tasks_created: r.tasks_created ?? 0,
                  },
                },
          ),
        },
      },
      {
        tenantId: bookkeepingTenantSlug,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
        requestId: correlationId,
      },
    );
  } catch (e) {
    // J5-H9: elevated to logger.error — `cron_dispatch_orchestrated`
    // is the ONLY operational record that the daily F8 cron actually
    // ran across tenants. Losing this audit silently breaks the
    // Principle VIII compliance trail — the team has no way to
    // distinguish "no work today" from "audit emit silently dropped".
    // Counter increment fires the alert pipeline (any non-zero rate =
    // stop-the-line per `renewalsMetrics.coordinatorAuditEmitFailed`
    // docstring).
    logger.error(
      {
        // K12-3 (REL-K-1): pass the Error instance so pino's `err`
        // serializer captures stack + type without the manual stack
        // field below.
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
      },
      'cron.renewals.coordinator.audit_emit_failed',
    );
    renewalsMetrics.coordinatorAuditEmitFailed('dispatch');
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // R5-BLK-1 (staff-review-2026-05-09): migrated from inline Bearer +
  // rate-limit + audit-emit to the shared `gateCronBearerOrRespond`
  // helper. The helper preserves all original behaviour:
  //   - constant-time Bearer compare (`verifyCronBearer` internally)
  //   - rate-limit on 401 path (per-IP, 60 req/60s) with Upstash fail-open
  //   - `cron_bearer_auth_rejected` audit emit with `route` discriminator
  //   - 429 with `Retry-After` when rate-limit hit
  //   - metrics counter on audit emit failure
  //
  // Returns null when Bearer check passes; otherwise returns the
  // appropriate NextResponse (401 / 429) for the caller to bubble up.
  // Mirrors the adoption pattern in at-risk-recompute, lapse-cycles,
  // and reconcile-pending-reactivations coordinators (Round-4 review C2).
  const gateResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/dispatch-coordinator',
    metricsCounter: () => renewalsMetrics.coordinatorAuditEmitFailed('dispatch'),
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (gateResponse) {
    return gateResponse;
  }

  // Kill-switch — returns 200 + skipped (no audit emit). cron-job.org
  // does NOT retry-storm on 200.
  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  // Phase 9 / T241 — READ_ONLY_MODE short-circuit. Mirrors the kill-switch
  // contract: 200 + skipped, no coordinator-level audit (the per-cycle
  // `renewal_reminder_deferred_read_only` audit only fires for cycles that
  // would have been dispatched, which is impossible during read-only). The
  // proxy layer (`src/proxy.ts:220`) already returns 503 on state-changing
  // member/admin/portal routes; coordinators run from cron-job.org which
  // hits the external Bearer-protected route and must NOT 503 (that would
  // trigger cron-job.org retry-storm) — so we return 200 like the
  // feature-flag short-circuit.
  if (env.flags.readOnlyMode) {
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  // K1-C1: generate a fresh server-side UUID rather than honouring an
  // inbound `x-request-id`. cron-job.org does not legitimately set this
  // header — and an attacker with `CRON_SECRET` could otherwise inject a
  // chosen correlationId that propagates verbatim into the
  // `cron_dispatch_orchestrated` audit + per-tenant emit sites,
  // fabricating forensic-trail attribution. Generating fresh closes that
  // class of incident-response forgery.
  const correlationId = uuidv7();

  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_dispatch_coordinator',
    {
      'cron.endpoint': 'dispatch-coordinator',
    },
    async (span) => {
      const startedAt = Date.now();

      // Resolve active tenants. MVP single-tenant = [env.tenant.slug].
      // Post-F10 SaaS would query a tenants table here.
      const activeTenants: ReadonlyArray<string> = [env.tenant.slug];
      span.setAttribute('renewals.tenants_enqueued', activeTenants.length);

      // Edge case: zero-tenant cron pass (Edge Cases CHK032 in spec.md
      // — "when a coordinator iterates and finds zero active tenants…
      // return 200 with tenants_enqueued: 0 and emit a single
      // cron_dispatch_orchestrated audit with tenants_enqueued: 0").
      if (activeTenants.length === 0) {
        const summary: OrchestratedSummary = {
          tenants_enqueued: 0,
          tenants_succeeded: 0,
          tenants_failed: 0,
          tenants_skipped_kill_switch: 0,
          duration_ms: Date.now() - startedAt,
        };
        await emitOrchestratedAudit(
          env.tenant.slug,
          summary,
          [],
          correlationId,
        );
        return NextResponse.json({
          skipped: false,
          ...summary,
          per_tenant_results: [],
        });
      }

      // Fan-out via internal fetch with Promise.allSettled. The
      // `env.app.baseUrl` is the same Vercel deployment URL — Vercel
      // routes the request to a fresh function instance per fetch, so
      // each tenant's work runs in its own 300s budget.
      const baseUrl = env.app.baseUrl;
      const cronSecret = env.cron.secret;

      const settled = await Promise.allSettled(
        activeTenants.map((tenantId) =>
          (async () => {
            const r = await fetch(
              `${baseUrl}/api/cron/renewals/dispatch/${encodeURIComponent(tenantId)}`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${cronSecret}`,
                  'x-request-id': correlationId,
                },
              },
            );
            // J5-H10: previously `r.json().catch(() => ({}))` silently
            // coerced ANY parse error to an empty object — including
            // the case where the per-tenant route returned 200 with a
            // Vercel edge HTML error page. The coordinator would then
            // count the tenant as succeeded with `reminders_dispatched=0`,
            // producing a clean audit record while the dispatch had
            // actually no-op'd. Now: track the parse outcome explicitly
            // so the per-tenant tally below can downgrade to failed.
            let json: Record<string, unknown> = {};
            let jsonParseFailed = false;
            try {
              json = (await r.json()) as Record<string, unknown>;
            } catch (e) {
              jsonParseFailed = true;
              logger.error(
                {
                  // K12-3 (REL-K-1): pass the Error instance so pino's
                  // `err` serializer captures stack + type.
                  err: e instanceof Error ? e : new Error(String(e)),
                  tenantId,
                  status: r.status,
                  contentType: r.headers.get('content-type'),
                  correlationId,
                },
                'cron.renewals.coordinator.json_parse_failed',
              );
            }
            return { tenantId, ok: r.ok, status: r.status, json, jsonParseFailed };
          })(),
        ),
      );

      const perTenantResults: PerTenantResult[] = settled.map((r, i) => {
        const tenantId = activeTenants[i]!;
        if (r.status === 'fulfilled' && r.value.ok && !r.value.jsonParseFailed) {
          return {
            tenant_id: tenantId,
            skipped: Boolean(r.value.json.skipped),
            reminders_dispatched:
              typeof r.value.json.reminders_dispatched === 'number'
                ? r.value.json.reminders_dispatched
                : 0,
            tasks_created:
              typeof r.value.json.tasks_created === 'number'
                ? r.value.json.tasks_created
                : 0,
            duration_ms:
              typeof r.value.json.duration_ms === 'number'
                ? r.value.json.duration_ms
                : 0,
          };
        }
        // J5-H1 + H10: log per-tenant failures at error level + emit
        // observability counter so dashboards graph failure mix and
        // alerting can fire on per-tenant patterns. Previously the
        // coordinator only logged the aggregate via `logger.info`
        // without per-tenant context — operators had to grep audit
        // payloads to identify which tenant failed.
        if (r.status === 'rejected') {
          const reasonStr = String(r.reason);
          logger.error(
            {
              tenantId,
              correlationId,
              reason: reasonStr.slice(0, 400),
            },
            'cron.renewals.coordinator.tenant_fetch_rejected',
          );
          renewalsMetrics.coordinatorTenantFailed(tenantId, 'rejected');
          return { tenant_id: tenantId, error: reasonStr };
        }
        if (r.value.jsonParseFailed) {
          renewalsMetrics.coordinatorTenantFailed(tenantId, 'json_parse_failed');
          return {
            tenant_id: tenantId,
            error: `http_${r.value.status}_json_parse_failed`,
          };
        }
        const kind: 'http_5xx' | 'http_4xx' =
          r.value.status >= 500 ? 'http_5xx' : 'http_4xx';
        logger.error(
          {
            tenantId,
            correlationId,
            status: r.value.status,
            errorBody: r.value.json,
          },
          'cron.renewals.coordinator.tenant_http_error',
        );
        renewalsMetrics.coordinatorTenantFailed(tenantId, kind);
        return {
          tenant_id: tenantId,
          error: `http_${r.value.status}`,
        };
      });

      // K5: distinguish kill-switch-skipped tenants from genuinely-
      // succeeded ones. A dark-launched tenant returning
      // `{skipped: true, reason: 'feature_flag_disabled'}` was
      // previously counted as `tenants_succeeded` — ops dashboards
      // green-flagged "100% healthy" while no work ran. Now the
      // skipped count surfaces alongside succeeded so an alert can
      // fire if a tenant unexpectedly drops to skipped state.
      const tenantsSucceededOrSkipped = perTenantResults.filter(
        (r): r is PerTenantResultOk => !('error' in r),
      );
      const tenantsSkippedKillSwitch = tenantsSucceededOrSkipped.filter(
        (r) => r.skipped,
      ).length;
      const tenantsSucceeded =
        tenantsSucceededOrSkipped.length - tenantsSkippedKillSwitch;
      const tenantsFailed =
        perTenantResults.length - tenantsSucceededOrSkipped.length;

      const summary: OrchestratedSummary = {
        tenants_enqueued: activeTenants.length,
        tenants_succeeded: tenantsSucceeded,
        tenants_failed: tenantsFailed,
        tenants_skipped_kill_switch: tenantsSkippedKillSwitch,
        duration_ms: Date.now() - startedAt,
      };

      span.setAttribute('renewals.tenants_succeeded', tenantsSucceeded);
      span.setAttribute('renewals.tenants_failed', tenantsFailed);
      span.setAttribute('renewals.duration_ms', summary.duration_ms);

      await emitOrchestratedAudit(
        env.tenant.slug,
        summary,
        perTenantResults,
        correlationId,
      );

      // Phase 9 / Cycle-state observable gauge wire-up. Run once per
      // successful tenant after the per-tenant fan-out completes; the
      // helper is best-effort + never blocks the coordinator.
      for (const result of tenantsSucceededOrSkipped) {
        if (result.skipped) continue;
        await observeCycleStateGaugesForTenant(result.tenant_id);
      }

      logger.info(
        {
          correlationId,
          ...summary,
        },
        'cron.renewals.coordinator.complete',
      );

      return NextResponse.json({
        skipped: false,
        ...summary,
        per_tenant_results: perTenantResults,
      });
    },
  );
}
