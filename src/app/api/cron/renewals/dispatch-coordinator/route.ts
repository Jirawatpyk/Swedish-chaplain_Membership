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
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { renewalsMetrics } from '@/lib/metrics';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { getClientIp } from '@/lib/client-ip';
import { makeRenewalsDeps } from '@/modules/renewals';

/**
 * K12-6 (SEC-K-5): cap audit-DB-write amplification on the 401 path.
 *
 * Without this, sustained bad-Bearer probing at 1k req/s would emit
 * 1k INSERT/s into `audit_log`. Vercel's per-region concurrency
 * provides some defence but does NOT eliminate the burst window.
 *
 * 60 requests / 60 sec is generous for legitimate rotation-window
 * scenarios (cron-job.org may briefly retry with the old secret
 * during a CRON_SECRET rotation; F4/F5/F7 cron jobs share the same
 * IP) while bounding the audit-write burst to 60 rows/min/IP. After
 * the limit is hit, subsequent 401s short-circuit with no DB write —
 * the `cron_bearer_auth_rejected` rate is preserved (one row per IP
 * per minute) which is sufficient for forensic detection of a
 * sustained probe.
 */
const BEARER_REJECT_RL_LIMIT = 60;
const BEARER_REJECT_RL_WINDOW_SECONDS = 60;

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
                  tasks_created: r.tasks_created ?? 0,
                  duration_ms: r.duration_ms ?? 0,
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
    renewalsMetrics.coordinatorAuditEmitFailed();
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Constant-time Bearer check (matches F4/F5/F7 cron pattern).
  if (
    !verifyCronBearer(request.headers.get('authorization'), env.cron.secret)
  ) {
    // K12-6 (SEC-K-5): rate-limit the 401 path BEFORE the audit emit
    // to cap audit-DB-write amplification under brute-force probing.
    // Once the limit is hit subsequent 401s short-circuit with no DB
    // write; the bearer_rejected rate signal is preserved at the
    // capped cadence (sufficient for forensic detection).
    //
    // K13-1 (REL-R12-1): Upstash outages must NOT cascade into 5xx on
    // the cron auth path. We FAIL OPEN — when `rateLimiter.check`
    // throws (Upstash unreachable, network timeout), we proceed with
    // the audit emit + 401 as if rate-limit had passed. The
    // `redisFallback` warn-log fires the alert pipeline so on-call
    // sees the Upstash degradation. The transient amplification window
    // during an Upstash outage is acceptable vs the alternative of
    // turning every cron auth-failure into a spurious 500 that pages
    // the F8 cron team while Upstash is unrelated to renewals.
    const ip = getClientIp(request);
    let rateLimited = false;
    try {
      const rl = await rateLimiter.check(
        `f8:cron:bearer-rejected:${ip}`,
        BEARER_REJECT_RL_LIMIT,
        BEARER_REJECT_RL_WINDOW_SECONDS,
      );
      if (!rl.success) {
        return NextResponse.json(
          { error: { code: 'rate_limited' } },
          {
            status: 429,
            headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) },
          },
        );
      }
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e : new Error(String(e)),
          route: '/api/cron/renewals/dispatch-coordinator',
        },
        'cron.renewals.coordinator.rate_limit_check_failed_fail_open',
      );
      rateLimited = false;
    }
    void rateLimited;

    // K6 / spec.md taxonomy line 365: emit `cron_bearer_auth_rejected`
    // audit so a sustained Bearer-rejection rate (e.g. CRON_SECRET
    // rotation incident, attacker probing) is forensically traceable.
    // Fire-and-forget; emit failure must NOT block the 401 response.
    try {
      const deps = makeRenewalsDeps(env.tenant.slug);
      await deps.auditEmitter.emit(
        {
          type: 'cron_bearer_auth_rejected',
          payload: { route: '/api/cron/renewals/dispatch-coordinator' },
        },
        {
          tenantId: env.tenant.slug,
          actorUserId: null,
          actorRole: 'cron',
          correlationId: uuidv7(),
          requestId: null,
        },
      );
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e : new Error(String(e)),
        },
        'cron.renewals.coordinator.bearer_rejected_audit_failed',
      );
    }
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // Kill-switch — returns 200 + skipped (no audit emit). cron-job.org
  // does NOT retry-storm on 200.
  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
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
